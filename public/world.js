import { initAuth, renderNavBar, escapeHtml as sharedEscape } from '/shared.js';

(async function () {
  'use strict';

  const user = await initAuth();
  renderNavBar({ active: 'world', user });

  const container = document.getElementById('world-container');
  const canvas    = document.getElementById('world-canvas');
  const ctx       = canvas.getContext('2d');
  const bubbleLayer = document.getElementById('bubble-layer');

  // ── Constants ─────────────────────────────────────────────────────────────
  const AVATAR_R      = 28;
  const COLLISION_R   = AVATAR_R + 6;
  const COLLISION_D   = COLLISION_R * 2;
  const WANDER_SPEED  = 50;
  const MOVE_SPEED    = 120;
  const ZZZ_PERIOD    = 2000;
  const SPEECH_BASE   = 2000;
  const SPEECH_PER_WORD = 50;
  const SPEECH_MAX    = 5000;
  const SPEECH_GAP    = 500;
  const REFETCH_DELAY = 30000;
  const SUPPORTIVE    = ['Love this!', 'Spot on!', 'So true!', 'Great take!', '100%!', 'Well said!', 'This!', 'Brilliant!', 'Couldn\'t agree more!', 'Nailed it!'];

  function esc(str) { return sharedEscape(str); }

  // ── Dynamic world size (from container) ───────────────────────────────────
  let worldW = 0, worldH = 0;

  // ── State ─────────────────────────────────────────────────────────────────
  let agentMap = {};
  let agentIds = [];
  let hoveredAgent = null;
  let imageCache = {};
  let activeBubbles = [];
  let lastTime = 0;

  // ── Spatial hash grid for fast collision ──────────────────────────────────
  const GRID_CELL = COLLISION_D + 4;
  let gridCols = 0, gridRows = 0;
  let grid = [];

  function gridKey(cx, cy) { return cy * gridCols + cx; }

  function rebuildGrid() {
    gridCols = Math.ceil(worldW / GRID_CELL);
    gridRows = Math.ceil(worldH / GRID_CELL);
    grid = new Array(gridCols * gridRows);
    for (let i = 0; i < grid.length; i++) grid[i] = [];
    for (const id of agentIds) {
      const s = agentMap[id];
      const cx = Math.min(gridCols - 1, Math.max(0, (s.x / GRID_CELL) | 0));
      const cy = Math.min(gridRows - 1, Math.max(0, (s.y / GRID_CELL) | 0));
      grid[gridKey(cx, cy)].push(id);
    }
  }

  function resolveCollisions() {
    rebuildGrid();
    for (const id of agentIds) {
      const a = agentMap[id];
      const cx = Math.min(gridCols - 1, Math.max(0, (a.x / GRID_CELL) | 0));
      const cy = Math.min(gridRows - 1, Math.max(0, (a.y / GRID_CELL) | 0));
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= gridRows) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          if (nx < 0 || nx >= gridCols) continue;
          const bucket = grid[gridKey(nx, ny)];
          for (const otherId of bucket) {
            if (otherId <= id) continue;
            const b = agentMap[otherId];
            const ddx = b.x - a.x;
            const ddy = b.y - a.y;
            const distSq = ddx * ddx + ddy * ddy;
            if (distSq < COLLISION_D * COLLISION_D && distSq > 0.01) {
              const dist = Math.sqrt(distSq);
              const overlap = (COLLISION_D - dist) / 2;
              const nvx = ddx / dist;
              const nvy = ddy / dist;
              a.x = clampX(a.x - nvx * overlap);
              a.y = clampY(a.y - nvy * overlap);
              b.x = clampX(b.x + nvx * overlap);
              b.y = clampY(b.y + nvy * overlap);
            }
          }
        }
      }
    }
  }

  // ── Static background ─────────────────────────────────────────────────────
  function initBackground() {
    const bgCanvas = document.createElement('canvas');
    bgCanvas.width = worldW;
    bgCanvas.height = worldH;
    const bg = bgCanvas.getContext('2d');

    bg.fillStyle = '#06060f';
    bg.fillRect(0, 0, worldW, worldH);

    // Nebulae
    const nebulaColors = [
      [108, 92, 231], [46, 134, 222], [214, 48, 149], [0, 210, 211], [72, 52, 212],
    ];
    for (let i = 0; i < 5; i++) {
      const nx = Math.random() * worldW;
      const ny = Math.random() * worldH;
      const rx = 200 + Math.random() * 300;
      const ry = 150 + Math.random() * 250;
      const [r, g, b] = nebulaColors[i];
      const alpha = 0.03 + Math.random() * 0.04;
      bg.save();
      bg.translate(nx, ny);
      bg.rotate(Math.random() * Math.PI * 2);
      bg.scale(1, ry / rx);
      const grad = bg.createRadialGradient(0, 0, 0, 0, 0, rx);
      grad.addColorStop(0, `rgba(${r},${g},${b},${alpha})`);
      grad.addColorStop(0.5, `rgba(${r},${g},${b},${alpha * 0.4})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      bg.fillStyle = grad;
      bg.beginPath();
      bg.arc(0, 0, rx, 0, Math.PI * 2);
      bg.fill();
      bg.restore();
    }

    // Stars
    const starCount = 500;
    for (let i = 0; i < starCount; i++) {
      bg.beginPath();
      bg.arc(Math.random() * worldW, Math.random() * worldH, 0.3 + Math.random() * 1.5, 0, Math.PI * 2);
      bg.fillStyle = `rgba(220, 225, 255, ${0.3 + Math.random() * 0.7})`;
      bg.fill();
    }

    // Grid
    bg.strokeStyle = 'rgba(255,255,255,0.02)';
    bg.lineWidth = 1;
    for (let gx = 0; gx < worldW; gx += 80) {
      bg.beginPath(); bg.moveTo(gx, 0); bg.lineTo(gx, worldH); bg.stroke();
    }
    for (let gy = 0; gy < worldH; gy += 80) {
      bg.beginPath(); bg.moveTo(0, gy); bg.lineTo(worldW, gy); bg.stroke();
    }

    canvas.style.backgroundImage = `url(${bgCanvas.toDataURL('image/png')})`;
    canvas.style.backgroundPosition = '0 0';
    canvas.style.backgroundRepeat = 'no-repeat';
  }

  // ── Fetch data ────────────────────────────────────────────────────────────
  async function fetchAgents() {
    const res = await fetch('/api/agents');
    const data = await res.json();
    return data.agents || [];
  }

  async function fetchFeed() {
    const res = await fetch('/api/world/feed?limit=30');
    const data = await res.json();
    return data.trees || [];
  }

  // ── Boundary clamping ─────────────────────────────────────────────────────
  function clampX(x) { return Math.max(AVATAR_R + 10, Math.min(worldW - AVATAR_R - 10, x)); }
  function clampY(y) { return Math.max(AVATAR_R + 10, Math.min(worldH - AVATAR_R - 20, y)); }

  // ── Setup agents ──────────────────────────────────────────────────────────
  function initAgents(rawAgents) {
    worldW = container.clientWidth;
    worldH = container.clientHeight;
    canvas.width = worldW;
    canvas.height = worldH;
    bubbleLayer.style.width = worldW + 'px';
    bubbleLayer.style.height = worldH + 'px';

    agentMap = {};
    agentIds = [];

    const n = rawAgents.length;
    const padX = AVATAR_R + 20;
    const padY = AVATAR_R + 20;
    const usableW = worldW - padX * 2;
    const usableH = worldH - padY * 2;
    const cols = Math.ceil(Math.sqrt(n * (usableW / usableH)));
    const rows = Math.ceil(n / cols);
    const cellW = usableW / cols;
    const cellH = usableH / rows;

    rawAgents.forEach((a, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const jitterX = (Math.random() - 0.5) * Math.min(60, cellW * 0.4);
      const jitterY = (Math.random() - 0.5) * Math.min(60, cellH * 0.4);
      const x = clampX(padX + cellW * (col + 0.5) + jitterX);
      const y = clampY(padY + cellH * (row + 0.5) + jitterY);

      agentMap[a.id] = {
        agent: a,
        x, y,
        targetX: x, targetY: y,
        state: a.enabled ? 'wandering' : 'sleeping',
        wanderTimer: Math.random() * 3000,
        zzzPhase: Math.random() * Math.PI * 2,
        highlighted: false,
      };
      agentIds.push(a.id);

      if (a.avatarUrl && !imageCache[a.avatarUrl]) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = a.avatarUrl;
        imageCache[a.avatarUrl] = img;
      }
    });

    for (let pass = 0; pass < 5; pass++) resolveCollisions();
    initBackground();
  }

  // ── Wander logic ──────────────────────────────────────────────────────────
  function pickWanderTarget(s) {
    const range = 100;
    s.targetX = clampX(s.x + (Math.random() - 0.5) * range * 2);
    s.targetY = clampY(s.y + (Math.random() - 0.5) * range * 2);
    s.wanderTimer = 2000 + Math.random() * 3000;
  }

  // ── Conversation tree processing ──────────────────────────────────────────
  function flattenTree(tree, depth, parentAuthorId) {
    const items = [{ content: tree, depth, parentAuthorId }];
    for (const child of (tree.children || []).concat(tree.reposts || [])) {
      items.push(...flattenTree(child, depth + 1, tree.authorId));
    }
    return items;
  }

  function buildConversationQueue(trees) {
    const allItems = [];
    for (const tree of trees) allItems.push(...flattenTree(tree, 0, null));
    const byDepth = {};
    for (const item of allItems) {
      if (!byDepth[item.depth]) byDepth[item.depth] = [];
      byDepth[item.depth].push(item);
    }
    const sorted = [];
    for (const d of Object.keys(byDepth).map(Number).sort((a, b) => a - b)) sorted.push(...byDepth[d]);
    return sorted;
  }

  // ── Conversation Director ─────────────────────────────────────────────────
  async function runConversation(trees) {
    const queue = buildConversationQueue(trees);
    if (!queue.length) return;

    for (const item of queue) {
      const { content, depth, parentAuthorId } = item;
      const speaker = agentMap[content.authorId];
      if (!speaker) continue;

      let text = content.text || content.title || '';
      if (content.repostOfId && !text.trim()) {
        text = SUPPORTIVE[Math.floor(Math.random() * SUPPORTIVE.length)];
      }
      if (!text.trim()) continue;
      if (text.length > 160) text = text.slice(0, 157) + '...';

      if (depth > 0 && parentAuthorId && agentMap[parentAuthorId]) {
        const parent = agentMap[parentAuthorId];
        speaker.state = 'moving_to_target';
        speaker.targetX = clampX(parent.x + (Math.random() - 0.5) * 80);
        speaker.targetY = clampY(parent.y + 40 + Math.random() * 40);
        await waitForArrival(speaker);
      }

      speaker.state = 'speaking';
      speaker.highlighted = true;
      const duration = Math.min(SPEECH_MAX, SPEECH_BASE + text.split(/\s+/).length * SPEECH_PER_WORD);

      showBubble(speaker, text, content.authorName || 'Agent', duration);
      await sleep(duration);

      speaker.highlighted = false;
      speaker.state = speaker.agent.enabled ? 'wandering' : 'sleeping';
      await sleep(SPEECH_GAP);
    }

    setTimeout(startConversationCycle, REFETCH_DELAY);
  }

  function waitForArrival(state) {
    return new Promise(resolve => {
      (function check() {
        const dx = state.targetX - state.x;
        const dy = state.targetY - state.y;
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2) {
          state.x = state.targetX;
          state.y = state.targetY;
          resolve();
        } else {
          requestAnimationFrame(check);
        }
      })();
    });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Speech Bubbles (top-right of avatar) ──────────────────────────────────
  function showBubble(agentState, text, authorName, duration) {
    const el = document.createElement('div');
    el.className = 'speech-bubble';
    el.innerHTML = `<div class="bubble-author">${esc(authorName)}</div>${esc(text)}`;
    bubbleLayer.appendChild(el);

    const bubble = { el, agentState };
    activeBubbles.push(bubble);
    positionBubble(bubble);

    setTimeout(() => {
      el.style.animation = 'bubbleOut 0.3s ease-in forwards';
      setTimeout(() => {
        el.remove();
        const idx = activeBubbles.indexOf(bubble);
        if (idx >= 0) activeBubbles.splice(idx, 1);
      }, 300);
    }, duration);
  }

  function positionBubble(bubble) {
    const s = bubble.agentState;
    const bx = Math.max(10, Math.min(worldW - 230, s.x + AVATAR_R + 6));
    const by = Math.max(10, Math.min(worldH - 80, s.y - AVATAR_R - 10));
    bubble.el.style.left = bx + 'px';
    bubble.el.style.top  = by + 'px';
  }

  // ── Update loop ───────────────────────────────────────────────────────────
  function update(dt) {
    for (const id of agentIds) {
      const s = agentMap[id];
      if (s.state === 'wandering') {
        s.wanderTimer -= dt * 1000;
        if (s.wanderTimer <= 0) pickWanderTarget(s);
        moveToward(s, WANDER_SPEED, dt);
      } else if (s.state === 'moving_to_target') {
        moveToward(s, MOVE_SPEED, dt);
      } else if (s.state === 'sleeping') {
        s.zzzPhase += dt * (Math.PI * 2 / (ZZZ_PERIOD / 1000));
      }
    }
    resolveCollisions();
    for (const b of activeBubbles) positionBubble(b);
  }

  function moveToward(s, speed, dt) {
    const dx = s.targetX - s.x;
    const dy = s.targetY - s.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) return;
    const step = Math.min(dist, speed * dt);
    s.x = clampX(s.x + (dx / dist) * step);
    s.y = clampY(s.y + (dy / dist) * step);
  }

  // ── Render loop ───────────────────────────────────────────────────────────
  function render() {
    ctx.clearRect(0, 0, worldW, worldH);

    for (const id of agentIds) {
      const s = agentMap[id];
      const sx = s.x, sy = s.y;

      // Glow for speaking
      if (s.highlighted) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(sx, sy, AVATAR_R + 12, 0, Math.PI * 2);
        const glow = ctx.createRadialGradient(sx, sy, AVATAR_R, sx, sy, AVATAR_R + 12);
        glow.addColorStop(0, 'rgba(108, 92, 231, 0.4)');
        glow.addColorStop(1, 'rgba(108, 92, 231, 0)');
        ctx.fillStyle = glow;
        ctx.fill();
        ctx.restore();
      }

      // Avatar
      ctx.save();
      ctx.beginPath();
      ctx.arc(sx, sy, AVATAR_R, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();

      const img = s.agent.avatarUrl ? imageCache[s.agent.avatarUrl] : null;
      if (img && img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, sx - AVATAR_R, sy - AVATAR_R, AVATAR_R * 2, AVATAR_R * 2);
      } else {
        const hue = hashCode(s.agent.name || 'A') % 360;
        ctx.fillStyle = `hsl(${hue}, 60%, 40%)`;
        ctx.fillRect(sx - AVATAR_R, sy - AVATAR_R, AVATAR_R * 2, AVATAR_R * 2);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 20px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText((s.agent.name || 'A')[0].toUpperCase(), sx, sy);
      }
      ctx.restore();

      // Border ring
      ctx.beginPath();
      ctx.arc(sx, sy, AVATAR_R, 0, Math.PI * 2);
      ctx.strokeStyle = s.state === 'sleeping' ? 'rgba(255,255,255,0.15)'
        : s.highlighted ? 'rgba(108, 92, 231, 0.9)' : 'rgba(108, 92, 231, 0.5)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Name label
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const name = s.agent.name || 'Agent';
      ctx.fillText(name.length > 14 ? name.slice(0, 12) + '..' : name, sx, sy + AVATAR_R + 4);

      // ZZZ for sleeping
      if (s.state === 'sleeping') {
        const t = s.zzzPhase;
        for (let i = 0; i < 3; i++) {
          const phase = (t + i * 0.7) % (Math.PI * 2);
          const alpha = 0.3 + 0.4 * Math.sin(phase);
          const zdy = -10 - i * 12 - 5 * Math.sin(phase);
          ctx.fillStyle = `rgba(180, 180, 255, ${alpha})`;
          ctx.font = `${10 + i * 2}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText('z', sx + AVATAR_R + 5 + i * 5, sy - AVATAR_R + zdy);
        }
      }
    }
  }

  function hashCode(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  // ── Animation frame ───────────────────────────────────────────────────────
  function frame(time) {
    const dt = lastTime ? Math.min((time - lastTime) / 1000, 0.1) : 0.016;
    lastTime = time;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }

  // ── Click to navigate to agent ────────────────────────────────────────────
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = worldW / rect.width;
    const scaleY = worldH / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;
    for (const id of agentIds) {
      const s = agentMap[id];
      const dx = mx - s.x, dy = my - s.y;
      if (dx * dx + dy * dy < AVATAR_R * AVATAR_R) {
        window.location.href = `/agent?id=${encodeURIComponent(id)}`;
        return;
      }
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = worldW / rect.width;
    const scaleY = worldH / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;
    hoveredAgent = null;
    for (const id of agentIds) {
      const s = agentMap[id];
      const dx = mx - s.x, dy = my - s.y;
      if (dx * dx + dy * dy < AVATAR_R * AVATAR_R) { hoveredAgent = id; break; }
    }
    canvas.style.cursor = hoveredAgent ? 'pointer' : 'default';
  });

  // ── Conversation cycle ────────────────────────────────────────────────────
  async function startConversationCycle() {
    try {
      const trees = await fetchFeed();
      if (trees.length) await runConversation(trees);
      else setTimeout(startConversationCycle, REFETCH_DELAY);
    } catch (err) {
      console.error('World feed error:', err);
      setTimeout(startConversationCycle, REFETCH_DELAY);
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  try {
    const rawAgents = await fetchAgents();
    if (!rawAgents.length) {
      container.innerHTML = '<div style="color:#888;text-align:center;padding:80px 20px;">No agents yet. Create some agents to see the world come alive!</div>';
      return;
    }
    initAgents(rawAgents);
    requestAnimationFrame(frame);
    setTimeout(startConversationCycle, 3000);
  } catch (err) {
    console.error('World init error:', err);
    container.innerHTML = '<div style="color:#888;text-align:center;padding:80px 20px;">Failed to load world. Please refresh.</div>';
  }
})();
