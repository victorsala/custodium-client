// Portada · l'exemple de pla: les línies element → persona, dibuixades un cop, i un impuls que les recorre.
// Portat de la web B2B. Només decoració: no toca cap dada ni cap estat de l'app.

const board = document.getElementById("plan-board");
const svg = board?.querySelector(".plan-links");

if (board && svg) {
  const NS = "http://www.w3.org/2000/svg";
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const links = [];

  for (const item of board.querySelectorAll(".plan-item")) {
    for (const id of item.dataset.to.split(/\s+/)) {
      const target = document.getElementById(id);
      if (!target) continue;
      const path = document.createElementNS(NS, "path");
      path.setAttribute("class", "plan-link");
      const pulse = document.createElementNS(NS, "path");
      pulse.setAttribute("class", "plan-pulse");
      pulse.setAttribute("pathLength", "100");
      pulse.style.animationDelay = `${-links.length * 1.1}s`;
      const end = document.createElementNS(NS, "circle");
      end.setAttribute("class", "plan-link-end");
      end.setAttribute("r", "3.5");
      end.style.animationDelay = pulse.style.animationDelay;
      svg.append(path, pulse, end);
      links.push({ item, target, path, pulse, end, drawn: false });
    }
  }

  // Posició respecte al tauler sense comptar les transformacions de l'animació d'entrada
  // (getBoundingClientRect les comptaria i, a la primera càrrega, les línies sortirien desplaçades).
  function rel(el) {
    let x = 0, y = 0;
    while (el && el !== board) {
      x += el.offsetLeft;
      y += el.offsetTop;
      const parent = el.offsetParent;
      if (parent && parent !== board) { x += parent.clientLeft; y += parent.clientTop; }
      el = parent;
    }
    return { x, y };
  }

  function layout() {
    svg.setAttribute("viewBox", `0 0 ${board.offsetWidth} ${board.offsetHeight}`);
    for (const l of links) {
      const dotEl = l.item.querySelector(".item-dot");
      const dot = rel(dotEl), t = rel(l.target);
      const x1 = dot.x + dotEl.offsetWidth / 2, y1 = dot.y + dotEl.offsetHeight / 2;
      const x2 = t.x, y2 = t.y + l.target.offsetHeight / 2;
      const dx = Math.max(24, (x2 - x1) / 2);
      const d = `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
      l.path.setAttribute("d", d);
      l.pulse.setAttribute("d", d);
      l.end.setAttribute("cx", x2);
      l.end.setAttribute("cy", y2);
      const len = l.path.getTotalLength();
      l.path.style.strokeDasharray = len;
      if (!l.drawn) { l.path.style.strokeDashoffset = len; l.end.style.opacity = "0"; }
    }
  }

  function draw(animate) {
    links.forEach((l, i) => {
      const go = () => {
        l.drawn = true;
        l.path.style.transition = animate ? "stroke-dashoffset 620ms ease-out" : "none";
        l.end.style.transition = animate ? "opacity 200ms ease-out 520ms" : "none";
        l.path.style.strokeDashoffset = "0";
        l.end.style.opacity = "1";
        const on = () => { if (!reduced) { l.pulse.classList.add("is-on"); l.end.classList.add("is-on"); } };
        if (animate) setTimeout(on, 700); else on();
      };
      if (animate) setTimeout(go, 1080 + i * 170); else go();
    });
  }

  // El tauler només es veu sense sessió (body.is-entry): amagat no té mida i no hi ha res a dibuixar.
  // ResizeObserver avisa quan apareix, quan canvia la finestra i quan les fonts acaben de carregar.
  let started = false;
  function tick() {
    if (!board.offsetWidth) return;
    layout();
    if (started) {
      if (links[0]?.drawn) draw(false);
      return;
    }
    started = true;
    if (reduced) {
      board.classList.add("is-static", "is-live");
      draw(false);
    } else {
      requestAnimationFrame(() => { board.classList.add("is-live"); draw(true); });
    }
  }

  new ResizeObserver(tick).observe(board);
  document.fonts?.ready.then(tick);
  tick();
}
