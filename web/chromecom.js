/* Copyright 2013 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* globals chrome */

import { DefaultExternalServices, PDFViewerApplication } from './app';
import { AppOptions } from './app_options';
import { BasePreferences } from './preferences';
import { DownloadManager } from './download_manager';
import { GenericL10n } from './genericl10n';
import { URL } from 'pdfjs-lib';

if (typeof PDFJSDev === 'undefined' || !PDFJSDev.test('CHROME')) {
  throw new Error('Module "pdfjs-web/chromecom" shall not be used outside ' +
                  'CHROME build.');
}

let ChromeCom = {
  /**
   * Creates an event that the extension is listening for and will
   * asynchronously respond by calling the callback.
   *
   * @param {String} action The action to trigger.
   * @param {String} data Optional data to send.
   * @param {Function} callback Optional response callback that will be called
   * with one data argument. When the request cannot be handled, the callback
   * is immediately invoked with no arguments.
   */
  request(action, data, callback) {
    let message = {
      action,
      data,
    };
    if (!chrome.runtime) {
      console.error('chrome.runtime is undefined.');
      if (callback) {
        callback();
      }
    } else if (callback) {
      chrome.runtime.sendMessage(message, callback);
    } else {
      chrome.runtime.sendMessage(message);
    }
  },

  /**
   * Resolves a PDF file path and attempts to detects length.
   *
   * @param {String} file - Absolute URL of PDF file.
   * @param {OverlayManager} overlayManager - Manager for the viewer overlays.
   * @param {Function} callback - A callback with resolved URL and file length.
   */
  resolvePDFFile(file, overlayManager, callback) {
    // Expand drive:-URLs to filesystem URLs (Chrome OS)
    file = file.replace(/^drive:/i,
        'filesystem:' + location.origin + '/external/');

    if (/^https?:/.test(file)) {
      // Assumption: The file being opened is the file that was requested.
      // There is no UI to input a different URL, so this assumption will hold
      // for now.
      setReferer(file, function() {
        callback(file);
      });
      return;
    }
    if (/^file?:/.test(file)) {
      getEmbedderOrigin(function(origin) {
        // If the origin cannot be determined, let Chrome decide whether to
        // allow embedding files. Otherwise, only allow local files to be
        // embedded from local files or Chrome extensions.
        // Even without this check, the file load in frames is still blocked,
        // but this may change in the future (https://crbug.com/550151).
        if (origin && !/^file:|^chrome-extension:/.test(origin)) {
          PDFViewerApplication.error('Blocked ' + origin + ' from loading ' +
              file + '. Refused to load a local file in a non-local page ' +
              'for security reasons.');
          return;
        }
        isAllowedFileSchemeAccess(function(isAllowedAccess) {
          if (isAllowedAccess) {
            callback(file);
          } else {
            requestAccessToLocalFile(file, overlayManager, callback);
          }
        });
      });
      return;
    }
    callback(file);
  },
};

function getEmbedderOrigin(callback) {
  let origin = window === top ? location.origin : location.ancestorOrigins[0];
  if (origin === 'null') {
    // file:-URLs, data-URLs, sandboxed frames, etc.
    getParentOrigin(callback);
  } else {
    callback(origin);
  }
}

function getParentOrigin(callback) {
  ChromeCom.request('getParentOrigin', null, callback);
}

function isAllowedFileSchemeAccess(callback) {
  ChromeCom.request('isAllowedFileSchemeAccess', null, callback);
}

function isRuntimeAvailable() {
  try {
    // When the extension is reloaded, the extension runtime is destroyed and
    // the extension APIs become unavailable.
    if (chrome.runtime && chrome.runtime.getManifest()) {
      return true;
    }
  } catch (e) {}
  return false;
}

function reloadIfRuntimeIsUnavailable() {
  if (!isRuntimeAvailable()) {
    location.reload();
  }
}

let chromeFileAccessOverlayPromise;
function requestAccessToLocalFile(fileUrl, overlayManager, callback) {
  let onCloseOverlay = null;
  if (top !== window) {
    // When the extension reloads after receiving new permissions, the pages
    // have to be reloaded to restore the extension runtime. Auto-reload
    // frames, because users should not have to reload the whole page just to
    // update the viewer.
    // Top-level frames are closed by Chrome upon reload, so there is no need
    // for detecting unload of the top-level frame. Should this ever change
    // (crbug.com/511670), then the user can just reload the tab.
    window.addEventListener('focus', reloadIfRuntimeIsUnavailable);
    onCloseOverlay = function() {
      window.removeEventListener('focus', reloadIfRuntimeIsUnavailable);
      reloadIfRuntimeIsUnavailable();
      overlayManager.close('chromeFileAccessOverlay');
    };
  }
  if (!chromeFileAccessOverlayPromise) {
    chromeFileAccessOverlayPromise = overlayManager.register(
      'chromeFileAccessOverlay',
      document.getElementById('chromeFileAccessOverlay'),
      onCloseOverlay, true);
  }
  chromeFileAccessOverlayPromise.then(function() {
    let iconPath = chrome.runtime.getManifest().icons[48];
    document.getElementById('chrome-pdfjs-logo-bg').style.backgroundImage =
      'url(' + chrome.runtime.getURL(iconPath) + ')';

    // Use Chrome's definition of UI language instead of PDF.js's #lang=...,
    // because the shown string should match the UI at chrome://extensions.
    // These strings are from chrome/app/resources/generated_resources_*.xtb.
    /* eslint-disable no-unexpected-multiline */
    let i18nFileAccessLabel =
      PDFJSDev.json('$ROOT/web/chrome-i18n-allow-access-to-file-urls.json')
      [chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()];
    /* eslint-enable no-unexpected-multiline */

    if (i18nFileAccessLabel) {
      document.getElementById('chrome-file-access-label').textContent =
        i18nFileAccessLabel;
    }

    let link = document.getElementById('chrome-link-to-extensions-page');
    link.href = 'chrome://extensions/?id=' + chrome.runtime.id;
    link.onclick = function(e) {
      // Direct navigation to chrome:// URLs is blocked by Chrome, so we
      // have to ask the background page to open chrome://extensions/?id=...
      e.preventDefault();
      // Open in the current tab by default, because toggling the file access
      // checkbox causes the extension to reload, and Chrome will close all
      // tabs upon reload.
      ChromeCom.request('openExtensionsPageForFileAccess', {
        newTab: e.ctrlKey || e.metaKey || e.button === 1 || window !== top,
      });
    };

    // Show which file is being opened to help the user with understanding
    // why this permission request is shown.
    document.getElementById('chrome-url-of-local-file').textContent = fileUrl;

    document.getElementById('chrome-file-fallback').onchange = function() {
      let file = this.files[0];
      if (file) {
        let originalFilename = decodeURIComponent(fileUrl.split('/').pop());
        let originalUrl = fileUrl;
        if (originalFilename !== file.name) {
          let msg = 'The selected file does not match the original file.' +
            '\nOriginal: ' + originalFilename +
            '\nSelected: ' + file.name +
            '\nDo you want to open the selected file?';
          if (!confirm(msg)) {
            this.value = '';
            return;
          }
          // There is no way to retrieve the original URL from the File object.
          // So just generate a fake path.
          originalUrl = 'file:///fakepath/to/' + encodeURIComponent(file.name);
        }
        callback(URL.createObjectURL(file), file.size, originalUrl);
        overlayManager.close('chromeFileAccessOverlay');
      }
    };

    overlayManager.open('chromeFileAccessOverlay');
  });
}

if (window === top) {
  // Chrome closes all extension tabs (crbug.com/511670) when the extension
  // reloads. To counter this, the tab URL and history state is saved to
  // localStorage and restored by extension-router.js.
  // Unfortunately, the window and tab index are not restored. And if it was
  // the only tab in an incognito window, then the tab is not restored either.
  addEventListener('unload', function() {
    // If the runtime is still available, the unload is most likely a normal
    // tab closure. Otherwise it is most likely an extension reload.
    if (!isRuntimeAvailable()) {
      localStorage.setItem(
        'unload-' + Date.now() + '-' + document.hidden + '-' + location.href,
        JSON.stringify(history.state));
    }
  });
}

// This port is used for several purposes:
// 1. When disconnected, the background page knows that the frame has unload.
// 2. When the referrer was saved in history.state.chromecomState, it is sent
//    to the background page.
// 3. When the background page knows the referrer of the page, the referrer is
//    saved in history.state.chromecomState.
let port;
// Set the referer for the given URL.
// 0. Background: If loaded via a http(s) URL: Save referer.
// 1. Page -> background: send URL and referer from history.state
// 2. Background: Bind referer to URL (via webRequest).
// 3. Background -> page: Send latest referer and save to history.
// 4. Page: Invoke callback.
function setReferer(url, callback) {
  if (!port) {
    // The background page will accept the port, and keep adding the Referer
    // request header to requests to |url| until the port is disconnected.
    port = chrome.runtime.connect({ name: 'chromecom-referrer', });
  }
  port.onDisconnect.addListener(onDisconnect);
  port.onMessage.addListener(onMessage);
  // Initiate the information exchange.
  port.postMessage({
    referer: window.history.state && window.history.state.chromecomState,
    requestUrl: url,
  });

  function onMessage(referer) {
    if (referer) {
      // The background extracts the Referer from the initial HTTP request for
      // the PDF file. When the viewer is reloaded or when the user navigates
      // back and forward, the background page will not observe a HTTP request
      // with Referer. To make sure that the Referer is preserved, store it in
      // history.state, which is preserved across reloads/navigations.
      let state = window.history.state || {};
      state.chromecomState = referer;
      window.history.replaceState(state, '');
    }
    onCompleted();
  }
  function onDisconnect() {
    // When the connection fails, ignore the error and call the callback.
    port = null;
    callback();
  }
  function onCompleted() {
    port.onDisconnect.removeListener(onDisconnect);
    port.onMessage.removeListener(onMessage);
    callback();
  }
}

// chrome.storage.sync is not supported in every Chromium-derivate.
// Note: The background page takes care of migrating values from
// chrome.storage.local to chrome.storage.sync when needed.
let storageArea = chrome.storage.sync || chrome.storage.local;

class ChromePreferences extends BasePreferences {
  async _writeToStorage(prefObj) {
    return new Promise((resolve) => {
      if (prefObj === this.defaults) {
        let keysToRemove = Object.keys(this.defaults);
        // If the storage is reset, remove the keys so that the values from
        // managed storage are applied again.
        storageArea.remove(keysToRemove, function() {
          resolve();
        });
      } else {
        storageArea.set(prefObj, function() {
          resolve();
        });
      }
    });
  }

  async _readFromStorage(prefObj) {
    return new Promise((resolve) => {
      let getPreferences = (defaultPrefs) => {
        if (chrome.runtime.lastError) {
          // Managed storage not supported, e.g. in Opera.
          defaultPrefs = this.defaults;
        }
        storageArea.get(defaultPrefs, function(readPrefs) {
          resolve(readPrefs);
        });
      };

      if (chrome.storage.managed) {
        // Get preferences as set by the system administrator.
        // See extensions/chromium/preferences_schema.json for more information.
        // These preferences can be overridden by the user.

        // Deprecated preferences are removed from web/default_preferences.json,
        // but kept in extensions/chromium/preferences_schema.json for backwards
        // compatibility with managed preferences.
        let defaultManagedPrefs = Object.assign({
          enableHandToolOnLoad: false,
          disableTextLayer: false,
          enhanceTextSelection: false,
        }, this.defaults);

        chrome.storage.managed.get(defaultManagedPrefs, function(items) {
          items = items || defaultManagedPrefs;
          // Migration logic for deprecated preferences: If the new preference
          // is not defined by an administrator (i.e. the value is the same as
          // the default value), and a deprecated preference is set with a
          // non-default value, migrate the deprecated preference value to the
          // new preference value.
          // Never remove this, because we have no means of modifying managed
          // preferences.

          // Migration code for https://github.com/mozilla/pdf.js/pull/7635.
          if (items.enableHandToolOnLoad && !items.cursorToolOnLoad) {
            items.cursorToolOnLoad = 1;
          }
          delete items.enableHandToolOnLoad;

          // Migration code for https://github.com/mozilla/pdf.js/pull/9479.
          if (items.textLayerMode !== 1) {
            if (items.disableTextLayer) {
              items.textLayerMode = 0;
            } else if (items.enhanceTextSelection) {
              items.textLayerMode = 2;
            }
          }
          delete items.disableTextLayer;
          delete items.enhanceTextSelection;

          getPreferences(items);
        });
      } else {
        // Managed storage not supported, e.g. in old Chromium versions.
        getPreferences(this.defaults);
      }
    });
  }
}

let ChromeExternalServices = Object.create(DefaultExternalServices);
ChromeExternalServices.initPassiveLoading = function(callbacks) {
  let { overlayManager, } = PDFViewerApplication;
  // defaultUrl is set in viewer.js
  ChromeCom.resolvePDFFile(AppOptions.get('defaultUrl'), overlayManager,
      function(url, length, originalUrl) {
    callbacks.onOpenWithURL(url, length, originalUrl);
  });
};
ChromeExternalServices.createDownloadManager = function(options) {
  return new DownloadManager(options);
};
ChromeExternalServices.createPreferences = function() {
  return new ChromePreferences();
};
ChromeExternalServices.createL10n = function(options) {
  return new GenericL10n(navigator.language);
};
PDFViewerApplication.externalServices = ChromeExternalServices;

export {
  ChromeCom,
};
