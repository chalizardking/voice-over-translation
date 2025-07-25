import VOTClient, { VOTWorkerClient } from "@vot.js/ext";
import YoutubeHelper from "@vot.js/ext/helpers/youtube";
import { getService, getVideoID } from "@vot.js/ext/utils/videoData";
import Chaimu, { initAudioContext } from "chaimu";
import { initAudioDownloaderIframe } from "./audioDownloader/iframe.ts";
import {
  actualCompatVersion,
  authServerUrl,
  defaultAutoHideDelay,
  defaultAutoVolume,
  defaultDetectService,
  defaultTranslationService,
  m3u8ProxyHost,
  minLongWaitingCount,
  proxyOnlyCountries,
  proxyWorkerHost,
  votBackendUrl,
  workerHost,
} from "./config/config.js";
import { initAuth } from "./core/auth.ts";
import { CacheManager } from "./core/cacheManager.ts";
import { VOTTranslationHandler } from "./core/translationHandler.ts";
import { VOTVideoManager } from "./core/videoManager.ts";
import { localizationProvider } from "./localization/localizationProvider.ts";
import { SubtitlesProcessor, SubtitlesWidget } from "./subtitles.js";
import { formatKeysCombo } from "./ui/components/hotkeyButton.ts";
import { UIManager } from "./ui/manager.ts";
import debug from "./utils/debug.ts";
import {
  GM_fetch,
  isProxyOnlyExtension,
  isSupportGMXhr,
  isUnsafeWindowAllowed,
} from "./utils/gm.ts";
import { IFRAME_HASH, isIframe } from "./utils/iframeConnector.ts";
import { updateConfig, votStorage } from "./utils/storage.ts";
import { translate } from "./utils/translateApis.ts";
import { browserInfo, calculatedResLang, initHls } from "./utils/utils.ts";
import { VideoObserver } from "./utils/VideoObserver.js";
import { VOTLocalizedError } from "./utils/VOTLocalizedError.js";
import { syncVolume } from "./utils/volume.ts";

export let countryCode; // Used later for proxy settings

/*─────────────────────────────────────────────────────────────*/
/*                        Main class: VideoHandler             */
/*  Composes the helper classes and retains full functionality.  */
/*─────────────────────────────────────────────────────────────*/
class VideoHandler {
  /** @type {import("@vot.js/shared/types/data").RequestLang} */
  translateFromLang = "auto";
  /** @type {import("@vot.js/shared/types/data").ResponseLang} */
  translateToLang = calculatedResLang;
  /** @type {number|undefined} */
  timer;
  /** @type {undefined|Partial<import("./types/storage.ts").StorageData>} */
  data;
  /** @type {undefined|object} */
  videoData;
  /** @type {boolean} */
  firstPlay = true;
  /** @type {AudioContext} */
  audioContext = initAudioContext();
  // For HLS streaming (if applicable)
  hls;
  /** @type {VOTClient|VOTWorkerClient} */
  votClient;
  /** @type {Chaimu} */
  audioPlayer;
  /** @type {AbortController|undefined} */
  abortController;
  /** @type {AbortController|undefined} */
  actionsAbortController;
  cacheManager; // cache for translation and subtitles
  downloadTranslationUrl = null;
  autoRetry; // auto retry timeout
  streamPing; // stream ping interval
  votOpts;
  volumeOnStart;
  tempOriginalVolume; // temp video volume for syncing
  tempVolume; // temp translation volume for syncing
  firstSyncVolume = true; // used for skip 1st syncing with observer
  longWaitingResCount = 0;
  subtitles = []; // current subtitle list

  /**
   * Constructs a new VideoHandler instance.
   * @param {HTMLVideoElement} video The video element to handle.
   * @param {HTMLElement} container The container element for the video.
   * @param {Object} site The site object associated with the video.
   */
  constructor(video, container, site) {
    debug.log(
      "[VideoHandler] add video:",
      video,
      "container:",
      container,
      this,
    );
    this.video = video;
    this.container = container;
    this.site = site;
    this.abortController = new AbortController();
    this.actionsAbortController = new AbortController();
    // Create helper instances
    this.uiManager = new UIManager({
      root: this.container,
      portalContainer: this.getPortalContainer(),
      tooltipLayoutRoot: this.getTooltipLayoutRoot(),
      data: this.data,
      videoHandler: this,
    });
    this.translationHandler = new VOTTranslationHandler(this);
    this.videoManager = new VOTVideoManager(this);
    this.cacheManager = new CacheManager();
  }

  // TODO: remove todo after refactor and maybe set as portalContainer getter
  getPortalContainer() {
    return this.site.host === "youtube" && this.site.additionalData !== "mobile"
      ? this.container.parentElement
      : this.container;
  }

  // TODO: remove todo after refactor and maybe set as tooltipLayoutRoot getter
  getTooltipLayoutRoot() {
    switch (this.site.host) {
      case "kickstarter": {
        return document.getElementById("react-project-header");
      }
      case "custom": {
        return undefined;
      }
      default: {
        return this.container;
      }
    }
  }

  /**
   * Returns the container element for event listeners.
   * @returns {HTMLElement} The event container.
   */
  getEventContainer() {
    if (!this.site.eventSelector) return this.container;
    if (this.site.host === "twitter")
      return this.container.closest(this.site.eventSelector);
    return document.querySelector(this.site.eventSelector);
  }

  /**
   * Auto-initiates translation if conditions are met.
   */
  async autoTranslate() {
    if (!(this.firstPlay && this.data.autoTranslate && this.videoData.videoId))
      return;
    this.firstPlay = false;
    try {
      this.videoManager.videoValidator();
      await this.uiManager.handleTranslationBtnClick();
    } catch (err) {
      console.error("[VOT]", err);
      return;
    }
  }

  /**
   * Determines if audio should be preferred.
   * @returns {boolean} True if audio is preferred.
   */
  getPreferAudio() {
    if (!this.audioContext) return true;
    if (!this.data.newAudioPlayer) return true;
    if (this.videoData.isStream) return true; // Use old player for streams with HLS
    if (this.data.newAudioPlayer && !this.data.onlyBypassMediaCSP) return false;
    return !this.site.needBypassCSP;
  }

  /**
   * Creates the audio player.
   * @returns {VideoHandler} The VideoHandler instance.
   */
  createPlayer() {
    const preferAudio = this.getPreferAudio();
    debug.log("preferAudio:", preferAudio);
    this.audioPlayer = new Chaimu({
      video: this.video,
      debug: DEBUG_MODE,
      fetchFn: GM_fetch,
      fetchOpts: {
        timeout: 0,
      },
      preferAudio,
    });
    return this;
  }

  /**
   * Initializes the VideoHandler: loads settings, UI, video data, events, etc.
   * @returns {Promise<void>}
   */
  async init() {
    if (this.initialized) return;

    // Retrieve settings from storage.
    this.data = await votStorage.getValues({
      autoTranslate: false,
      dontTranslateLanguages: [calculatedResLang],
      enabledDontTranslateLanguages: true,
      enabledAutoVolume: true,
      autoVolume: defaultAutoVolume,
      buttonPos: "default",
      showVideoSlider: true,
      syncVolume: false,
      downloadWithName: isSupportGMXhr,
      sendNotifyOnComplete: false,
      subtitlesMaxLength: 300,
      highlightWords: false,
      subtitlesFontSize: 20,
      subtitlesOpacity: 20,
      subtitlesDownloadFormat: "srt",
      responseLanguage: calculatedResLang,
      defaultVolume: 100,
      onlyBypassMediaCSP: Number(!!this.audioContext),
      newAudioPlayer: Number(!!this.audioContext),
      showPiPButton: false,
      translateAPIErrors: true,
      translationService: defaultTranslationService,
      detectService: defaultDetectService,
      translationHotkey: null,
      m3u8ProxyHost,
      proxyWorkerHost,
      translateProxyEnabled: 0,
      translateProxyEnabledDefault: true,
      audioBooster: false,
      useLivelyVoice: false,
      autoHideButtonDelay: defaultAutoHideDelay,
      useAudioDownload: isUnsafeWindowAllowed,
      compatVersion: "",
      account: {},
      localeHash: "",
      localeUpdatedAt: 0,
    });
    if (this.data.compatVersion !== actualCompatVersion) {
      this.data = await updateConfig(this.data);
      await votStorage.set("compatVersion", actualCompatVersion);
    }

    this.uiManager.data = this.data;
    this.tempVolume = this.data.defaultVolume;
    console.log("[VOT] data from db: ", this.data);

    // Enable translate proxy if extension isn't compatible with GM_xmlhttpRequest
    if (!this.data.translateProxyEnabled && isProxyOnlyExtension) {
      this.data.translateProxyEnabled = 1;
    }
    // Determine country for proxy purposes
    if (!countryCode) {
      try {
        const response = await GM_fetch("https://speed.cloudflare.com/meta", {
          timeout: 7000,
        });
        ({ country: countryCode } = await response.json());
      } catch (err) {
        console.error("[VOT] Error getting country:", err);
      }
    }

    if (
      proxyOnlyCountries.includes(countryCode) &&
      this.data.translateProxyEnabledDefault
    ) {
      this.data.translateProxyEnabled = 2;
    }

    debug.log(
      "translateProxyEnabled",
      this.data.translateProxyEnabled,
      this.data.translateProxyEnabledDefault,
    );
    debug.log("Extension compatibility passed...");

    this.initVOTClient();

    // Initialize UI elements and events.
    this.uiManager.initUI();
    this.uiManager.initUIEvents();

    // Initialize subtitles widget.
    this.subtitlesWidget = new SubtitlesWidget(
      this.video,
      this.getPortalContainer(),
      this.site,
      this.uiManager.votOverlayView.votOverlayPortal,
      this.getTooltipLayoutRoot(),
    );
    this.subtitlesWidget.setMaxLength(this.data.subtitlesMaxLength);
    this.subtitlesWidget.setHighlightWords(this.data.highlightWords);
    this.subtitlesWidget.setFontSize(this.data.subtitlesFontSize);
    this.subtitlesWidget.setOpacity(this.data.subtitlesOpacity);

    // Get video data and create player.
    this.createPlayer();
    this.setSelectMenuValues(
      this.videoData.detectedLanguage,
      this.data.responseLanguage ?? "ru",
    );

    this.translateToLang = this.data.responseLanguage ?? "ru";
    this.initExtraEvents();

    await this.autoTranslate();

    this.initialized = true;
  }

  /**
   * Initializes the VOT client.
   * @returns {VideoHandler} This instance.
   */
  initVOTClient() {
    this.votOpts = {
      fetchFn: GM_fetch,
      fetchOpts: {
        signal: this.actionsAbortController.signal,
      },
      apiToken: this.data.account?.token,
      hostVOT: votBackendUrl,
      host: this.data.translateProxyEnabled
        ? this.data.proxyWorkerHost
        : workerHost,
    };
    this.votClient = new (
      this.data.translateProxyEnabled ? VOTWorkerClient : VOTClient
    )(this.votOpts);
    return this;
  }

  /**
   * Sets the translation button state and text.
   * @param {string} status The new status.
   * @param {string} text The text to display.
   * @returns {VideoHandler} This instance.
   */
  transformBtn(status, text) {
    this.uiManager.transformBtn(status, text);
    return this;
  }

  /**
   * @returns {boolean} True if the extension audio player has active audio source
   */
  hasActiveSource() {
    return !!(this.audioPlayer.player.src || this.hls?.url);
  }

  /**
   * Initializes extra event listeners (resize, click outside, keydown, etc.).
   */
  initExtraEvents() {
    const { signal } = this.abortController;
    const addExtraEventListener = (element, event, handler) => {
      element.addEventListener(event, handler, {
        signal,
      });
    };
    const addExtraEventListeners = (element, events, handler) => {
      for (const event of events) {
        addExtraEventListener(element, event, handler);
      }
    };

    // Update menu container height on resize.
    this.resizeObserver = new ResizeObserver((entries) => {
      for (const e of entries) {
        this.uiManager.votOverlayView.votMenu.container.style.setProperty(
          "--vot-container-height",
          `${e.contentRect.height}px`,
        );
      }

      const { position, direction } =
        this.uiManager.votOverlayView.calcButtonLayout(this.data?.buttonPos);
      this.uiManager.votOverlayView.updateButtonLayout(position, direction);
    });
    this.resizeObserver.observe(this.video);
    this.uiManager.votOverlayView.votMenu.container.style.setProperty(
      "--vot-container-height",
      `${this.video.getBoundingClientRect().height}px`,
    );

    // Sync volume slider with original YouTube video.
    if (
      ["youtube", "googledrive"].includes(this.site.host) &&
      this.site.additionalData !== "mobile"
    ) {
      this.syncVolumeObserver = new MutationObserver((mutations) => {
        if (!this.audioPlayer.player.src || !this.data.syncVolume) return;
        for (const mutation of mutations) {
          if (
            mutation.type === "attributes" &&
            mutation.attributeName === "aria-valuenow"
          ) {
            if (this.firstSyncVolume) {
              this.firstSyncVolume = false;
              return;
            }
            const videoVolume = this.isMuted()
              ? 0
              : this.getVideoVolume() * 100;
            const finalVolume = Math.round(videoVolume);
            this.data.defaultVolume = finalVolume;
            this.audioPlayer.player.volume = this.data.defaultVolume / 100;
            this.syncVolumeWrapper("video", finalVolume);
          }
        }
      });
      const ytpVolumePanel = document.querySelector(".ytp-volume-panel");
      if (ytpVolumePanel) {
        this.syncVolumeObserver.observe(ytpVolumePanel, {
          attributes: true,
          subtree: true,
        });
      }
    }

    // Global document click event: hide menu if click is outside.
    document.addEventListener(
      "click",
      (event) => {
        const e = event.target;
        const button = this.uiManager.votOverlayView.votButton.container;
        const menu = this.uiManager.votOverlayView.votMenu.container;
        const container = this.container;
        const settings = this.uiManager.votSettingsView.dialog.container;
        const tempDialog = document.querySelector(".vot-dialog-temp");
        const isButton = button.contains(e);
        const isMenu = menu.contains(e);
        const isVideo = container.contains(e);
        const isSettings = settings.contains(e);
        const isTempDialog = tempDialog?.contains(e) ?? false;
        debug.log(
          `[document click] ${isButton} ${isMenu} ${isVideo} ${isSettings} ${isTempDialog}`,
        );
        if (!(!isButton && !isMenu && !isSettings && !isTempDialog)) return;
        if (!isVideo) this.uiManager.votOverlayView.updateButtonOpacity(0);
        this.uiManager.votOverlayView.votMenu.hidden = true;
      },
      {
        signal,
      },
    );

    // Global keydown: trigger translation hotkey if appropriate.
    // Set of key combinations pressed by the user
    const userPressedKeys = new Set();

    document.addEventListener(
      "keydown",
      async (event) => {
        if (event.repeat) {
          // prevent unnecessary calls
          return;
        }

        userPressedKeys.add(event.code);

        const activeElement = document.activeElement;
        const isInputElement =
          ["input", "textarea"].includes(activeElement.tagName.toLowerCase()) ||
          activeElement.isContentEditable;
        if (isInputElement) {
          return;
        }

        const combo = formatKeysCombo(userPressedKeys);

        debug.log(`combo: ${combo}`);
        debug.log(
          `this.data.translationHotkey: ${this.data.translationHotkey}`,
        );

        if (combo === this.data.translationHotkey) {
          await this.uiManager.handleTranslationBtnClick();
        }
      },
      { signal },
    );

    document.addEventListener("blur", () => {
      // clear the pressed keys when page lost focus
      userPressedKeys.clear();
    });

    document.addEventListener(
      "keyup",
      (event) => {
        userPressedKeys.delete(event.code);
      },
      { signal },
    );

    const eventContainer = this.getEventContainer();
    if (eventContainer)
      addExtraEventListeners(
        eventContainer,
        ["pointermove", "pointerout"],
        this.resetTimer,
      );

    addExtraEventListener(
      this.uiManager.votOverlayView.votButton.container,
      "pointermove",
      this.changeOpacityOnEvent,
    );
    addExtraEventListener(
      this.uiManager.votOverlayView.votMenu.container,
      "pointermove",
      this.changeOpacityOnEvent,
    );
    // fix #866
    if (this.site.host !== "xvideos")
      addExtraEventListener(document, "touchmove", this.resetTimer);

    // fix draggable menu in youtube (#394, #417)
    if (this.site.host === "youtube") {
      this.container.draggable = false;
    }

    addExtraEventListener(this.video, "canplay", async () => {
      if (this.site.host === "rutube" && this.video.src) return;
      await this.setCanPlay();
    });
    addExtraEventListener(this.video, "emptied", async () => {
      const videoId = await getVideoID(this.site, {
        fetchFn: GM_fetch,
        video: this.video,
      });
      if (
        this.video.src &&
        this.videoData &&
        videoId === this.videoData.videoId
      )
        return;
      debug.log("lipsync mode is emptied");
      this.videoData = undefined;
      this.stopTranslation();
    });
    if (!["rutube", "ok"].includes(this.site.host)) {
      addExtraEventListener(this.video, "volumechange", () => {
        this.syncVideoVolumeSlider();
      });
    }
    if (this.site.host === "youtube" && !this.site.additionalData) {
      addExtraEventListener(document, "yt-page-data-updated", async () => {
        debug.log("yt-page-data-updated");
        // fix #802
        if (!window.location.pathname.includes("/shorts/")) return;
        await this.setCanPlay();
      });
    }
  }

  /**
   * Called when the video can play.
   */
  async setCanPlay() {
    const videoId = await getVideoID(this.site, {
      fetchFn: GM_fetch,
      video: this.video,
    });
    if (this.videoData && videoId === this.videoData.videoId) {
      return;
    }
    await this.handleSrcChanged();
    await this.autoTranslate();
    debug.log("lipsync mode is canplay");
  }

  /**
   * Resets the auto-hide timer for the UI.
   */
  resetTimer = () => {
    clearTimeout(this.timer);
    this.uiManager.votOverlayView.updateButtonOpacity(1);
    this.timer = setTimeout(() => {
      this.uiManager.votOverlayView.updateButtonOpacity(0);
    }, this.data.autoHideButtonDelay);
  };

  /**
   * Changes the opacity when an event occurs.
   * @param {Event} event The event object.
   */
  changeOpacityOnEvent = (event) => {
    clearTimeout(this.timer);
    this.uiManager.votOverlayView.updateButtonOpacity(1);
    event.stopPropagation();
  };

  /**
   * Changes subtitles language based on user selection.
   * @param {string} subs The subtitles selection value.
   */
  async changeSubtitlesLang(subs) {
    debug.log("[onchange] subtitles", subs);
    this.uiManager.votOverlayView.subtitlesSelect.setSelectedValue(subs);
    if (subs === "disabled") {
      this.subtitlesWidget.setContent(null);
      this.uiManager.votOverlayView.downloadSubtitlesButton.hidden = true;
      this.yandexSubtitles = null;
    } else {
      const subtitlesObj = this.subtitles.at(Number.parseInt(subs));
      if (
        this.data.translateProxyEnabled === 2 &&
        subtitlesObj.url.startsWith(
          "https://brosubs.s3-private.mds.yandex.net/vtrans/",
        )
      ) {
        const subsPath = subtitlesObj.url.replace(
          "https://brosubs.s3-private.mds.yandex.net/vtrans/",
          "",
        );
        subtitlesObj.url = `https://${this.data.proxyWorkerHost}/video-subtitles/subtitles-proxy/${subsPath}`;
        console.log(`[VOT] Subs proxied via ${subtitlesObj.url}`);
      }
      this.yandexSubtitles =
        await SubtitlesProcessor.fetchSubtitles(subtitlesObj);
      this.subtitlesWidget.setContent(
        this.yandexSubtitles,
        subtitlesObj.language,
      );
      this.uiManager.votOverlayView.downloadSubtitlesButton.hidden = false;
    }
  }

  /**
   * Updates the subtitles selection options.
   */
  async updateSubtitlesLangSelect() {
    if (!this.subtitles || this.subtitles.length === 0) {
      const updatedOptions = [
        {
          label: localizationProvider.get("VOTSubtitlesDisabled"),
          value: "disabled",
          selected: true,
          disabled: false,
        },
      ];
      this.uiManager.votOverlayView.subtitlesSelect.updateItems(updatedOptions);
      await this.changeSubtitlesLang(updatedOptions[0].value);
      return;
    }
    const updatedOptions = [
      {
        label: localizationProvider.get("VOTSubtitlesDisabled"),
        value: "disabled",
        selected: true,
        disabled: false,
      },
      ...this.subtitles.map((s, idx) => ({
        label:
          (localizationProvider.get(`langs.${s.language}`) ??
            s.language.toUpperCase()) +
          (s.translatedFromLanguage
            ? ` ${localizationProvider.get("VOTTranslatedFrom")} ${
                localizationProvider.get(`langs.${s.translatedFromLanguage}`) ??
                s.translatedFromLanguage.toUpperCase()
              }`
            : "") +
          (s.source !== "yandex" ? `, ${window.location.hostname}` : "") +
          (s.isAutoGenerated
            ? ` (${localizationProvider.get("VOTAutogenerated")})`
            : ""),
        value: idx,
        selected: false,
        disabled: false,
      })),
    ];
    this.uiManager.votOverlayView.subtitlesSelect.updateItems(updatedOptions);
    await this.changeSubtitlesLang(updatedOptions[0].value);
  }

  /**
   * Loads subtitles for the current video.
   */
  async loadSubtitles() {
    if (!this.videoData?.videoId) {
      console.error(
        `[VOT] ${localizationProvider.getDefault("VOTNoVideoIDFound")}`,
      );
      this.subtitles = [];
      return;
    }
    const cacheKey = `${this.videoData.videoId}_${this.videoData.detectedLanguage}_${this.videoData.responseLanguage}_${this.data.useLivelyVoice}`;
    try {
      let cachedSubs = this.cacheManager.getSubtitles(cacheKey);
      if (!cachedSubs) {
        cachedSubs = await SubtitlesProcessor.getSubtitles(
          this.votClient,
          this.videoData,
        );
        this.cacheManager.setSubtitles(cacheKey, cachedSubs);
      }
      this.subtitles = cachedSubs;
    } catch (error) {
      console.error("[VOT] Failed to load subtitles:", error);
      this.subtitles = [];
    }
    await this.updateSubtitlesLangSelect();
  }

  isLivelyVoiceAllowed() {
    // allowed only en -> ru pair
    if (
      this.videoData.detectedLanguage !== "en" ||
      this.videoData.responseLanguage !== "ru"
    ) {
      return false;
    }

    // allowed only with auth
    if (!this.data.account?.token) {
      return false;
    }

    return true;
  }

  /**
   * Gets the video volume.
   * @returns {number} The video volume (0.0 - 1.0).
   */
  getVideoVolume() {
    return this.videoManager.getVideoVolume();
  }

  /**
   * Sets the video volume.
   * @param {number} volume A number between 0 and 1.
   * @returns {VideoHandler} This instance.
   */
  setVideoVolume(volume) {
    this.videoManager.setVideoVolume(volume);
    return this;
  }

  /**
   * Checks if the video is muted.
   * @returns {boolean} True if muted.
   */
  isMuted() {
    return this.videoManager.isMuted();
  }

  /**
   * Syncs the video volume slider.
   */
  syncVideoVolumeSlider() {
    this.videoManager.syncVideoVolumeSlider();
  }

  /**
   * Sets language select menu values.
   * @param {string} from Source language.
   * @param {string} to Target language.
   */
  setSelectMenuValues(from, to) {
    this.videoManager.setSelectMenuValues(from, to);
  }

  /**
   * Wraps over syncVolume for slider syncing.
   * @param {"translation"|"video"} fromType The initiator slider.
   * @param {number} newVolume The new volume value.
   */
  syncVolumeWrapper(fromType, newVolume) {
    const slider =
      fromType === "translation"
        ? this.uiManager.votOverlayView.videoVolumeSlider
        : this.uiManager.votOverlayView.translationVolumeSlider;
    const finalValue = syncVolume(
      fromType === "translation" ? this.video : this.audioPlayer.player,
      newVolume,
      slider.value,
      fromType === "translation" ? this.tempVolume : this.tempOriginalVolume,
    );
    slider.value = finalValue;
    this.tempOriginalVolume =
      fromType === "translation" ? finalValue : newVolume;
    this.tempVolume = fromType === "translation" ? newVolume : finalValue;
  }

  /**
   * Retrieves video data.
   * @returns {Promise<Object>} The video data object.
   */
  async getVideoData() {
    return await this.videoManager.getVideoData();
  }

  /**
   * Validates the video.
   * @returns {boolean} True if valid.
   */
  videoValidator() {
    return this.videoManager.videoValidator();
  }

  /**
   * Stops translation and resets UI elements.
   */
  stopTranslate() {
    this.audioPlayer.player.removeVideoEvents();
    this.audioPlayer.player.clear();
    this.audioPlayer.player.src = undefined;
    debug.log("audioPlayer after stopTranslate", this.audioPlayer);
    this.uiManager.votOverlayView.videoVolumeSlider.hidden = true;
    this.uiManager.votOverlayView.translationVolumeSlider.hidden = true;
    this.uiManager.votOverlayView.downloadTranslationButton.hidden = true;
    this.downloadTranslationUrl = null;
    this.longWaitingResCount = 0;
    this.transformBtn("none", localizationProvider.get("translateVideo"));
    debug.log(`Volume on start: ${this.volumeOnStart}`);
    if (this.volumeOnStart) {
      this.setVideoVolume(this.volumeOnStart);
    }
    clearInterval(this.streamPing);
    clearTimeout(this.autoRetry);
    this.hls?.destroy();
    this.firstSyncVolume = true;
    this.actionsAbortController = new AbortController();
  }

  /**
   * Updates the translation error message on the UI.
   * @param {string|Error} errorMessage The error message.
   */
  async updateTranslationErrorMsg(errorMessage) {
    const translationTake = localizationProvider.get("translationTake");
    const lang = localizationProvider.lang;
    this.longWaitingResCount =
      errorMessage === localizationProvider.get("translationTakeAboutMinute")
        ? this.longWaitingResCount + 1
        : 0;
    debug.log("longWaitingResCount", this.longWaitingResCount);
    if (this.longWaitingResCount > minLongWaitingCount) {
      errorMessage = new VOTLocalizedError("TranslationDelayed");
    }
    debug.log("updateTranslationErrorMsg message", errorMessage);
    if (errorMessage?.name === "VOTLocalizedError") {
      this.transformBtn("error", errorMessage.localizedMessage);
    } else if (errorMessage instanceof Error) {
      this.transformBtn("error", errorMessage?.message);
    } else if (
      this.data.translateAPIErrors &&
      lang !== "ru" &&
      !errorMessage?.includes(translationTake)
    ) {
      this.uiManager.votOverlayView.votButton.loading = true;
      const translatedMessage = await translate(errorMessage, "ru", lang);
      this.transformBtn("error", translatedMessage);
    } else {
      this.transformBtn("error", errorMessage);
    }
    if (
      [
        "Подготавливаем перевод",
        "Видео передано в обработку",
        "Ожидаем перевод видео",
        "Загружаем переведенное аудио",
      ].includes(errorMessage)
    ) {
      this.uiManager.votOverlayView.votButton.loading = true;
    }
  }

  /**
   * Called after translation is updated.
   * @param {string} audioUrl The URL of the translation audio.
   */
  afterUpdateTranslation(audioUrl) {
    const isSuccess =
      this.uiManager.votOverlayView.votButton.container.dataset.status ===
      "success";
    this.uiManager.votOverlayView.videoVolumeSlider.hidden =
      !this.data.showVideoSlider || !isSuccess;
    this.uiManager.votOverlayView.translationVolumeSlider.hidden = !isSuccess;
    if (this.data.enabledAutoVolume) {
      this.uiManager.votOverlayView.videoVolumeSlider.value =
        this.data.autoVolume;
    }

    if (!this.videoData.isStream) {
      this.uiManager.votOverlayView.downloadTranslationButton.hidden = false;
      this.downloadTranslationUrl = audioUrl;
    }
    debug.log(
      "afterUpdateTranslation downloadTranslationUrl",
      this.downloadTranslationUrl,
    );
    if (
      this.data.sendNotifyOnComplete &&
      this.longWaitingResCount &&
      isSuccess
    ) {
      GM_notification({
        text: localizationProvider
          .get("VOTTranslationCompletedNotify")
          .replace("{0}", window.location.hostname),
        title: GM_info.script.name,
        timeout: 5000,
        silent: true,
        tag: "VOTTranslationCompleted", // TM 5.0
        onclick: () => {
          window.focus();
        },
      });
    }
  }

  /**
   * Validates the audio URL by sending a request.
   * @param {string} audioUrl The audio URL to validate.
   * @returns {Promise<string>} The valid audio URL.
   */
  async validateAudioUrl(audioUrl) {
    try {
      const fetchOpts = this.isMultiMethodS3(audioUrl)
        ? {
            method: "HEAD",
          }
        : {
            // some s3 don't support the same signature for different methods
            headers: {
              range: "bytes=0-0",
            },
          };
      const response = await GM_fetch(audioUrl, fetchOpts);
      debug.log("Test audio response", response);
      if (response.ok) {
        debug.log("Valid audioUrl", audioUrl);
        return audioUrl;
      }
      debug.log("Yandex returned not valid audio, trying to fix...");
      this.videoData.detectedLanguage = "auto";
      const translateRes = await this.translationHandler.translateVideoImpl(
        this.videoData,
        this.videoData.detectedLanguage,
        this.videoData.responseLanguage,
        this.videoData.translationHelp,
        !this.data.useAudioDownload,
        this.actionsAbortController.signal,
      );
      this.setSelectMenuValues(
        this.videoData.detectedLanguage,
        this.videoData.responseLanguage,
      );
      audioUrl = translateRes.url;
      debug.log("Fixed audio audioUrl", audioUrl);
    } catch (err) {
      debug.log("Test audio error:", err);
    }
    return audioUrl;
  }

  /**
   * Proxifies the audio URL if needed.
   * @param {string} audioUrl The original audio URL.
   * @returns {string} The proxified audio URL.
   */
  proxifyAudio(audioUrl) {
    if (
      this.data.translateProxyEnabled === 2 &&
      audioUrl.startsWith("https://vtrans.s3-private.mds.yandex.net/tts/prod/")
    ) {
      audioUrl = audioUrl.replace(
        "https://vtrans.s3-private.mds.yandex.net/tts/prod/",
        `https://${this.data.proxyWorkerHost}/video-translation/audio-proxy/`,
      );
      console.log(`[VOT] Audio proxied via ${audioUrl}`);
    }
    return audioUrl;
  }

  isMultiMethodS3(url) {
    return (
      url.startsWith("https://vtrans.s3-private.mds.yandex.net/tts/prod/") ||
      url.startsWith(
        `https://${this.data.proxyWorkerHost}/video-translation/audio-proxy/`,
      )
    );
  }

  /**
   * Updates the translation audio source.
   * @param {string} audioUrl The audio URL.
   */
  async updateTranslation(audioUrl) {
    if (audioUrl !== this.audioPlayer.player.currentSrc) {
      audioUrl = await this.validateAudioUrl(this.proxifyAudio(audioUrl));
    }
    if (this.audioPlayer.player.src !== audioUrl) {
      this.audioPlayer.player.src = audioUrl;
    }
    try {
      this.audioPlayer.init();
    } catch (err) {
      debug.log("this.audioPlayer.init() error", err);
      this.transformBtn("error", err.message);
    }
    this.setupAudioSettings();
    if (this.site.host === "twitter") {
      document
        .querySelector('button[data-testid="app-bar-back"][role="button"]')
        .addEventListener("click", this.stopTranslation);
    }
    this.transformBtn("success", localizationProvider.get("disableTranslate"));
    this.afterUpdateTranslation(audioUrl);
  }

  /**
   * Translates the video/audio.
   * @param {string} VIDEO_ID The video ID.
   * @param {boolean} isStream Whether the video is a stream.
   * @param {string} requestLang Source language.
   * @param {string} responseLang Target language.
   * @param {any} translationHelp Optional translation helper data.
   */
  async translateFunc(
    VIDEO_ID,
    isStream,
    requestLang,
    responseLang,
    translationHelp,
  ) {
    console.log("[VOT] Video Data: ", this.videoData);
    debug.log("Run videoValidator");
    this.videoValidator();
    this.uiManager.votOverlayView.votButton.loading = true;
    this.volumeOnStart = this.getVideoVolume();
    const cacheKey = `${VIDEO_ID}_${requestLang}_${responseLang}_${this.data.useLivelyVoice}`;
    const cachedEntry = this.cacheManager.getTranslation(cacheKey);
    if (cachedEntry?.url) {
      await this.updateTranslation(cachedEntry.url);
      debug.log("[translateFunc] Cached translation was received");
      return;
    }
    if (cachedEntry?.error) {
      debug.log("Skip translation - previous attempt failed");
      await this.updateTranslationErrorMsg(cachedEntry.error.data?.message);
      return;
    }
    if (isStream) {
      const translateRes = await this.translationHandler.translateStreamImpl(
        this.videoData,
        requestLang,
        responseLang,
        this.actionsAbortController.signal,
      );
      if (!translateRes) {
        debug.log("Skip translation");
        return;
      }
      this.transformBtn(
        "success",
        localizationProvider.get("disableTranslate"),
      );
      try {
        this.hls = initHls();
        this.audioPlayer.init();
      } catch (err) {
        debug.log("this.audioPlayer.init() error", err);
        this.transformBtn("error", err.message);
      }
      const streamURL = this.setHLSSource(translateRes.result.url);
      if (this.site.host === "youtube") {
        YoutubeHelper.videoSeek(this.video, 10);
      }
      this.setupAudioSettings();
      if (!this.video.src && !this.video.currentSrc && !this.video.srcObject) {
        return this.stopTranslation();
      }
      return this.afterUpdateTranslation(streamURL);
    }
    const translateRes = await this.translationHandler.translateVideoImpl(
      this.videoData,
      requestLang,
      responseLang,
      translationHelp,
      !this.data.useAudioDownload,
      this.actionsAbortController.signal,
    );
    debug.log("[translateRes]", translateRes);
    if (!translateRes) {
      debug.log("Skip translation");
      return;
    }
    await this.updateTranslation(translateRes.url);
    // Invalidate subtitles cache if there is no matching subtitle.
    const cachedSubs = this.cacheManager.getSubtitles(cacheKey);
    if (
      !cachedSubs?.some(
        (item) =>
          item.source === "yandex" &&
          item.translatedFromLanguage === this.videoData.detectedLanguage &&
          item.language === this.videoData.responseLanguage,
      )
    ) {
      this.cacheManager.deleteSubtitles(cacheKey);
      this.subtitles = [];
    }
    this.cacheManager.setTranslation(cacheKey, {
      videoId: VIDEO_ID,
      from: requestLang,
      to: responseLang,
      url: this.downloadTranslationUrl,
      useLivelyVoice: this.data?.useLivelyVoice,
    });
  }

  /**
   * used for enable audio downloader on this hosts
   */
  isYouTubeHosts() {
    return ["youtube", "invidious", "piped", "poketube", "ricktube"].includes(
      this.site.host,
    );
  }

  /**
   * Sets up HLS streaming if needed.
   * @param {string} streamURL The HLS stream URL.
   */
  setupHLS(streamURL) {
    this.hls.on(Hls.Events.MEDIA_ATTACHED, function () {
      debug.log("audio and hls.js are now bound together !");
    });
    this.hls.on(Hls.Events.MANIFEST_PARSED, function (data) {
      debug.log(`manifest loaded, found ${data?.levels?.length} quality level`);
    });
    this.hls.loadSource(streamURL);
    this.hls.attachMedia(this.audioPlayer.player.audio);
    this.hls.on(Hls.Events.ERROR, function (data) {
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.MEDIA_ERROR:
            console.log("fatal media error encountered, try to recover");
            this.hls.recoverMediaError();
            break;
          case Hls.ErrorTypes.NETWORK_ERROR:
            console.error("fatal network error encountered", data);
            break;
          default:
            this.hls.destroy();
            break;
        }
      }
    });
    debug.log(this.hls);
  }

  /**
   * Sets the HLS source URL.
   * @param {string} url The original URL.
   * @returns {string} The final stream URL.
   */
  setHLSSource(url) {
    const streamURL = `https://${this.data.m3u8ProxyHost}/?all=yes&origin=${encodeURIComponent("https://strm.yandex.ru")}&referer=${encodeURIComponent("https://strm.yandex.ru")}&url=${encodeURIComponent(url)}`;
    if (this.hls) {
      this.setupHLS(streamURL);
    } else if (
      this.audioPlayer.player.audio.canPlayType("application/vnd.apple.mpegurl")
    ) {
      this.audioPlayer.player.src = streamURL; // For Safari
    } else {
      throw new VOTLocalizedError("audioFormatNotSupported");
    }
    return streamURL;
  }

  /**
   * Configures audio settings such as volume.
   */
  setupAudioSettings() {
    if (typeof this.data.defaultVolume === "number") {
      this.audioPlayer.player.volume = this.data.defaultVolume / 100;
    }
    if (this.data.enabledAutoVolume) {
      this.setVideoVolume((this.data.autoVolume / 100).toFixed(2));
    }
  }

  /**
   * Stops translation and synchronizes volume.
   */
  stopTranslation = () => {
    this.stopTranslate();
    this.syncVideoVolumeSlider();
  };

  /**
   * Handles video source change events.
   */
  async handleSrcChanged() {
    debug.log("[VideoHandler] src changed", this);
    this.firstPlay = true;
    this.stopTranslation();
    const hide =
      !this.video.src && !this.video.currentSrc && !this.video.srcObject;
    this.uiManager.votOverlayView.votButton.container.hidden = hide;
    if (hide) this.uiManager.votOverlayView.votMenu.hidden = hide;
    if (!this.site.selector) this.container = this.video.parentElement;
    if (
      !this.container.contains(
        this.uiManager.votOverlayView.votButton.container,
      )
    ) {
      this.container.append(
        this.uiManager.votOverlayView.votButton.container,
        this.uiManager.votOverlayView.votMenu.container,
      );
    }
    this.videoData = await this.getVideoData();
    const cacheKey = `${this.videoData.videoId}_${this.videoData.detectedLanguage}_${this.videoData.responseLanguage}_${this.data.useLivelyVoice}`;
    this.subtitles = this.cacheManager.getSubtitles(cacheKey);
    await this.updateSubtitlesLangSelect();
    this.translateToLang = this.data.responseLanguage ?? "ru";
    this.setSelectMenuValues(
      this.videoData.detectedLanguage,
      this.videoData.responseLanguage,
    );
    this.actionsAbortController = new AbortController();
  }

  /**
   * Releases resources and removes event listeners.
   */
  async release() {
    debug.log("[VideoHandler] release");
    this.initialized = false;
    this.releaseExtraEvents();
    this.subtitlesWidget.release();
    this.uiManager.release();
  }

  /**
   * Collects report information for bug reporting.
   * @returns {Object} Report info object.
   */
  collectReportInfo() {
    const os = `${browserInfo.os.name} ${browserInfo.os.version}`;
    const additionalInfo = `<details>
<summary>Autogenerated by VOT:</summary>
<ul>
  <li>OS: ${os}</li>
  <li>Browser: ${browserInfo.browser.name} ${browserInfo.browser.version}</li>
  <li>Loader: ${GM_info.scriptHandler} v${GM_info.version}</li>
  <li>Script version: ${GM_info.script.version}</li>
  <li>URL: <code>${window.location.href}</code></li>
  <li>Lang: <code>${this.videoData.detectedLanguage}</code> -> <code>${this.videoData.responseLanguage}</code> (Lively voice: ${this.data.useLivelyVoice} | Audio download: ${this.data.useAudioDownload})</li>
  <li>Player: ${this.data.newAudioPlayer ? "New" : "Old"} (CSP only: ${this.data.onlyBypassMediaCSP})</li>
  <li>Proxying mode: ${this.data.translateProxyEnabled}</li>
</ul>
</details>`;
    const template = `1-bug-report-${localizationProvider.lang === "ru" ? "ru" : "en"}.yml`;
    return {
      assignees: "ilyhalight",
      template,
      os,
      "script-version": GM_info.script.version,
      "additional-info": additionalInfo,
    };
  }

  /**
   * Releases extra event listeners.
   */
  releaseExtraEvents() {
    this.abortController.abort();
    this.resizeObserver?.disconnect();
    if (
      ["youtube", "googledrive"].includes(this.site.host) &&
      this.site.additionalData !== "mobile"
    ) {
      this.syncVolumeObserver?.disconnect();
    }
  }
}

const videoObserver = new VideoObserver();
const videosWrappers = new WeakMap();

/**
 * Recursively finds the closest parent element matching a selector.
 * @param {HTMLElement} el The starting element.
 * @param {string} selector The CSS selector.
 * @returns {HTMLElement|null} The matching parent element.
 */
function climb(el, selector) {
  if (!el || !selector) return null;
  if (el instanceof Document) return el.querySelector(selector);
  const foundEl = el.closest(selector);
  if (foundEl) return foundEl;
  const root = el.getRootNode();
  return climb(root instanceof ShadowRoot ? root.host : root, selector);
}

/**
 * Finds the container element for a given video.
 * @param {Object} site The site object.
 * @param {HTMLVideoElement} video The video element.
 * @returns {HTMLElement|null} The container element.
 */
function findContainer(site, video) {
  debug.log("findContainer", site, video);
  if (site.shadowRoot) {
    const container = climb(video, site.selector);
    debug.log("findContainer with site.shadowRoot", container);
    return container ?? video.parentElement;
  }
  debug.log("findContainer without shadowRoot");
  if (!site.selector) return video.parentElement;
  const elements = document.querySelectorAll(site.selector);
  return (
    Array.from(elements).find((e) => e.contains(video)) ?? video.parentElement
  );
}

/**
 * Initializes iframe communication for special cases.
 */
function initIframeInteractor() {
  const configs = {
    "https://dev.epicgames.com": {
      targetOrigin: "https://dev.epicgames.com",
      dataFilter: (data) =>
        typeof data === "string" && data.startsWith("getVideoId:"),
      extractVideoId: (url) => url.pathname.split("/").slice(-2, -1)[0],
      iframeSelector: (src) => `electra-player > iframe[src="${src}"]`,
      responseFormatter: (videoId, data) => `${data}:${videoId}`,
      processRequest: (data) => {
        const reqId = data.replace("getVideoId:", "");
        return atob(reqId);
      },
    },
  };

  const currentConfig = Object.entries(configs).find(
    ([origin]) =>
      window.location.origin === origin &&
      (origin !== "https://dev.epicgames.com" ||
        window.location.pathname.includes("/community/learning/")),
  )?.[1];
  if (!currentConfig) return;
  window.addEventListener("message", (event) => {
    try {
      if (event.origin !== currentConfig.targetOrigin) return;
      if (!currentConfig.dataFilter(event.data)) return;
      const url = new URL(window.location.href);
      const videoId = currentConfig.extractVideoId(url);
      if (!videoId) return;
      const iframeSrc = currentConfig.processRequest?.(event.data) || url.href;
      const selector =
        typeof currentConfig.iframeSelector === "function"
          ? currentConfig.iframeSelector(iframeSrc)
          : currentConfig.iframeSelector;
      const iframe = document.querySelector(selector);
      if (!iframe?.contentWindow) return;
      const response = currentConfig.responseFormatter(videoId, event.data);
      iframe.contentWindow.postMessage(response, currentConfig.targetOrigin);
    } catch (error) {
      console.error("Iframe communication error:", error);
    }
  });
}

/**
 * Main function to start the extension.
 */
async function main() {
  console.log("[VOT] Loading extension...");
  if (isIframe() && window.location.hash.includes(IFRAME_HASH)) {
    return initAudioDownloaderIframe();
  }

  if (window.location.origin === authServerUrl) {
    return await initAuth();
  }

  await localizationProvider.update();
  debug.log(`Selected menu language: ${localizationProvider.lang}`);
  initIframeInteractor();
  videoObserver.onVideoAdded.addListener(async (video) => {
    if (videosWrappers.has(video)) return;

    let container;
    const site = getService().find((site) => {
      container = findContainer(site, video);
      return Boolean(container);
    });

    if (!site) return;
    if (["peertube", "directlink"].includes(site.host)) {
      // set the url of the current site for peertube and directlink
      site.url = window.location.origin;
    }

    try {
      const videoHandler = new VideoHandler(video, container, site);
      videoHandler.videoData = await videoHandler.getVideoData();
      await videoHandler.init();
      videosWrappers.set(video, videoHandler);
    } catch (err) {
      console.error("[VOT] Failed to initialize videoHandler", err);
    }
  });
  videoObserver.onVideoRemoved.addListener(async (video) => {
    if (videosWrappers.has(video)) {
      await videosWrappers.get(video).release();
      videosWrappers.delete(video);
    }
  });
  videoObserver.enable();
}

main().catch((e) => {
  console.error("[VOT]", e);
});
