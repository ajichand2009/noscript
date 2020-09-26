"use strict";

(this.ns || (this.ns = {})).syncFetchPolicy = function() {

  let url = document.URL;

  // Here we've got no CSP header yet (file: or ftp: URL), we need one
  // injected in the DOM as soon as possible.
  debug("No CSP yet for non-HTTP document load: fetching policy synchronously...");

  let syncFetch = callback => {
    browser.runtime.sendSyncMessage(
      {id: "fetchPolicy", url, contextUrl: url},
      callback);
  };
  debug("Initial readyState and body", document.readyState, document.body);

  let mustFreeze = UA.isMozilla && (!/^(?:image|video|audio)/.test(document.contentType) || document instanceof XMLDocument);
  if (mustFreeze) {
    // Mozilla has already parsed the <head> element, we must take extra steps...

    try {
      DocumentFreezer.freeze();

      ns.on("capabilities", () => {

        let {readyState} = document;

        debug("Readystate: %s, suppressedScripts = %s, canScript = %s", readyState, DocumentFreezer.suppressedScripts, ns.canScript);

        if (!ns.canScript) {
          setTimeout(() => DocumentFreezer.unfreeze(), 0);
          let normalizeDir = () => {
            // Chromium does this automatically. We need it to understand we're a directory earlier and allow browser UI scripts.
            if (document.baseURI === document.URL + "/") {
              location.replace(document.baseURI);
            }
          }
          if (DocumentFreezer.firedDOMContentLoaded) {
            normalizeDir();
          } else {
            addEventListener("readystatechange", normalizeDir);
          }
          return;
        }

        if (DocumentFreezer.suppressedScripts === 0 && readyState === "loading") {
          // we don't care reloading, if no script has been suppressed
          // and no readyState change has been fired yet
          DocumentFreezer.unfreeze();
          return;
        }

        let softReload = ev => {
           try {
            debug("Soft reload", ev); // DEV_ONLY
            try {
              let doc = window.wrappedJSObject.document;
              if (ev) ev.currentTarget.removeEventListener(ev.type, softReload, true);

              let isDir = document.querySelector("link[rel=stylesheet][href^='chrome:']")
                  && document.querySelector(`base[href^="${url}"]`);
              if (isDir || document.contentType !== "text/html") {
                throw new Error(`Can't document.write() on ${isDir ? "directory listings" : document.contentType}`)
              }

              DocumentFreezer.unfreeze();

              let html = document.documentElement.outerHTML;
              let sx = window.scrollX, sy = window.scrollY;
              doc.open();
              console.debug("Opened", doc.documentElement);
              doc.write(html);
              doc.close();
              debug("Written", html);
              // Work-around this rendering bug: https://forums.informaction.com/viewtopic.php?p=103105#p103050
              debug("Scrolling back to", sx, sy);
              window.scrollTo(sx, sy);
            } catch (e) {
              debug("Can't use document.write(), XML document?", e);
              try {
                let eventSuppressor = ev => {
                  if (ev.isTrusted) {
                    debug("Suppressing natural event", ev);
                    ev.preventDefault();
                    ev.stopImmediatePropagation();
                    ev.currentTarget.removeEventListener(ev.type, eventSuppressor, true);
                  }
                };
                let svg = document.documentElement instanceof SVGElement;
                if (svg) {
                  document.addEventListener("SVGLoad", eventSuppressor, true);
                }
                document.addEventListener("DOMContentLoaded", eventSuppressor, true);
                DocumentFreezer.unfreeze();
                let scripts = [], deferred = [];
                // push deferred scripts, if any, to the end
                for (let s of [...document.querySelectorAll("script")]) {
                   (s.defer && !s.text ? deferred : scripts).push(s);
                   s.addEventListener("beforescriptexecute", e => {
                    console.debug("Suppressing", script);
                    e.preventDefault();
                  });
                }
                if (deferred.length) scripts.push(...deferred);
                let doneEvents = ["afterscriptexecute", "load", "error"];
                (async () => {
                  for (let s of scripts) {
                    let clone = document.createElementNS(s.namespaceURI, "script");
                    for (let a of s.attributes) {
                      clone.setAttributeNS(a.namespaceURI, a.name, a.value);
                    }
                    clone.innerHTML = s.innerHTML;
                    await new Promise(resolve => {
                      let listener = ev => {
                        if (ev.target !== clone) return;
                        debug("Resolving on ", ev.type, ev.target);
                        resolve(ev.target);
                        for (let et of doneEvents) removeEventListener(et, listener, true);
                      };
                      for (let et of doneEvents) {
                        addEventListener(et, listener, true);
                       }
                      s.replaceWith(clone);
                      debug("Replaced", clone);
                    });
                  }
                  debug("All scripts done, firing completion events.");
                  document.dispatchEvent(new Event("readystatechange"));
                  if (svg) {
                    document.documentElement.dispatchEvent(new Event("SVGLoad"));
                  }
                  document.dispatchEvent(new Event("DOMContentLoaded", {
                    bubbles: true,
                    cancelable: true
                  }));
                  if (document.readyState === "complete") {
                    window.dispatchEvent(new Event("load"));
                  }
                })();
              } catch (e) {
                error(e);
              }
            }
          } catch(e) {
            error(e);
          }
        };

        if (DocumentFreezer.firedDOMContentLoaded) {
          softReload();
        } else {
          debug("Deferring softReload to DOMContentLoaded...");
          addEventListener("DOMContentLoaded", softReload, true);
        }

      });
    } catch (e) {
      error(e);
    }
  }

  let setup = policy => {
    debug("Fetched %o, readyState %s", policy, document.readyState); // DEV_ONLY
    ns.setup(policy);
  }

  for (let attempts = 3; attempts-- > 0;) {
    try {
      syncFetch(setup);
      break;
    } catch (e) {
      if (!Messages.isMissingEndpoint(e) || document.readyState === "complete") {
        error(e);
        break;
      }
      error("Background page not ready yet, retrying to fetch policy...")
    }
  }
};

if (this.ns.pendingSyncFetchPolicy) {
  this.ns.pendingSyncFetchPolicy = false;
  this.ns.syncFetchPolicy();
}