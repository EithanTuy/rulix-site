(function () {
  function blurTransition(tl, oldScene, newScene, time) {
    tl.to(
      oldScene,
      { filter: "blur(14px)", scale: 1.025, opacity: 0, duration: 0.56, ease: "power2.inOut" },
      time
    );
    tl.fromTo(
      newScene,
      { filter: "blur(12px)", scale: 0.985, opacity: 0 },
      { filter: "blur(0px)", scale: 1, opacity: 1, duration: 0.62, ease: "power1.out" },
      time + 0.08
    );
  }

  function enterScene(tl, scene, time, hold) {
    tweenIf(tl, scene + " .scene-kicker", "from", { opacity: 0, x: -34, duration: 0.46, ease: "expo.out" }, time + 0.18);
    tweenIf(tl, scene + " .scene-title", "from", { opacity: 0, y: 42, scale: 0.985, duration: 0.68, ease: "power3.out" }, time + 0.28);
    tweenIf(tl, scene + " .scene-copy", "from", { opacity: 0, y: 24, duration: 0.54, ease: "sine.out" }, time + 0.44);
    tweenIf(tl, scene + " .question-card", "from", { opacity: 0, x: -26, duration: 0.5, ease: "back.out(1.2)" }, time + 0.56);
    tweenIf(tl, scene + " .proof-strip span", "from", { opacity: 0, y: 18, duration: 0.34, stagger: 0.06, ease: "power4.out" }, time + 0.66);
    tweenIf(tl, scene + " .screen-shell", "from", { opacity: 0, x: 44, scale: 0.965, duration: 0.74, ease: "expo.out" }, time + 0.24);
    tweenIf(tl, scene + " .media-tag", "from", { opacity: 0, y: -14, duration: 0.38, ease: "power2.out" }, time + 0.48);
    tweenIf(tl, scene + " .timecode", "from", { opacity: 0, y: -14, duration: 0.42, ease: "power1.out" }, time + 0.52);
    tweenIf(tl, scene + " .callout", "from", { opacity: 0, x: 26, scale: 0.98, duration: 0.44, stagger: 0.1, ease: "power3.out" }, time + 0.76);
    tweenIf(tl, scene + " .data-ribbon span", "from", { opacity: 0, y: 18, duration: 0.38, stagger: 0.06, ease: "power2.out" }, time + 0.88);
    tweenIf(tl, scene + " .scanner", "from", { opacity: 0, duration: 0.36, ease: "power1.out" }, time + 0.8);
    tweenIf(tl, scene + " .screen-image", "to", { scale: 1.018, duration: Math.max(1.1, hold - 0.55), ease: "sine.inOut" }, time + 0.52);
    tweenIf(tl, scene + " .scanner", "to", { x: 410, duration: Math.max(1.1, hold - 0.9), ease: "sine.inOut" }, time + 0.96);
  }

  function tweenIf(tl, selector, method, vars, time) {
    if (!document.querySelector(selector)) return;
    tl[method](selector, vars, time);
  }

  window.createRulixTimeline = function createRulixTimeline(compositionId, scenes, duration) {
    var tl = gsap.timeline({ paused: true });
    tl.from("#" + compositionId + " .backgrid", { opacity: 0, duration: 0.7, ease: "sine.out" }, 0.12);
    tl.from("#" + compositionId + " .edge-rule", { opacity: 0, scaleX: 0.94, duration: 0.7, ease: "power1.out" }, 0.16);
    for (var i = 0; i < scenes.length; i += 1) {
      var current = scenes[i];
      var next = scenes[i + 1];
      var nextAt = next ? next.at : duration;
      enterScene(tl, "#" + current.id, current.at, nextAt - current.at);
      if (next) {
        blurTransition(tl, "#" + current.id, "#" + next.id, next.at - 0.48);
      }
    }
    tl.from("#" + compositionId + " .final-mark", { opacity: 0, y: 14, duration: 0.42, ease: "power2.out" }, duration - 0.76);
    return tl;
  };
})();
