// Runs in MAIN world (page context) at document_start, before Lichess JS loads.
// Lichess's chessground library checks event.isTrusted on mousedown, rejecting
// synthetic events from extensions. This patches addEventListener so that when
// chessground binds its mousedown handler on cg-board, untrusted events are
// wrapped in a Proxy that spoofs isTrusted = true.
(function() {
  const origAEL = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, fn, options) {
    if (type === "mousedown" && this.tagName === "CG-BOARD") {
      const origFn = fn;
      fn = function(e) {
        if (!e.isTrusted) {
          const proxy = new Proxy(e, {
            get(target, prop) {
              if (prop === "isTrusted") return true;
              const val = Reflect.get(target, prop);
              return typeof val === "function" ? val.bind(target) : val;
            }
          });
          return origFn.call(this, proxy);
        }
        return origFn.call(this, e);
      };
    }
    return origAEL.call(this, type, fn, options);
  };
})();