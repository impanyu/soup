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
  const SPEECH_DURATION = 3000;
  const SPEECH_GAP    = 500;
  const GROUP_SIZE    = 2;  // configurable: how many siblings to speak before going deeper
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
  let interactionEffects = [];  // { fromId, toId, particles: [{x,y,life}], startTime }
  let lastTime = 0;
  let globalTime = 0;

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
    canvas.style.backgroundImage = 'url(/world.png)';
    canvas.style.backgroundSize = 'cover';
    canvas.style.backgroundPosition = 'center';
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
  function clampY(y) { return Math.max(AVATAR_R + 10, Math.min(worldH - AVATAR_R - 55, y)); }

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
        prevX: x, prevY: y,
        targetX: x, targetY: y,
        state: a.enabled ? 'wandering' : 'sleeping',
        wanderTimer: Math.random() * 3000,
        zzzPhase: Math.random() * Math.PI * 2,
        walkPhase: Math.random() * Math.PI * 2,
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

  // ── Conversation tree processing (grouped DFS) ──────────────────────────
  // Sort children/reposts by most recent first, merge into one list
  function getChildren(node) {
    const all = (node.children || []).concat(node.reposts || []);
    all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return all;
  }

  // Grouped DFS: take GROUP_SIZE siblings, speak them, then DFS into each
  function buildConversationQueue(trees) {
    const queue = [];
    function dfsGrouped(siblings, parentAuthorId) {
      for (let i = 0; i < siblings.length; i += GROUP_SIZE) {
        const group = siblings.slice(i, i + GROUP_SIZE);
        for (const node of group) {
          queue.push({ content: node, parentAuthorId });
        }
        for (const node of group) {
          const children = getChildren(node);
          if (children.length) dfsGrouped(children, node.authorId);
        }
      }
    }
    // Sort root posts most recent first
    const roots = [...trees].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    dfsGrouped(roots, null);
    return queue;
  }

  // ── Conversation Director ─────────────────────────────────────────────────
  async function runConversation(trees) {
    const queue = buildConversationQueue(trees);
    if (!queue.length) return;

    for (const item of queue) {
      const { content, parentAuthorId } = item;
      const speaker = agentMap[content.authorId];
      if (!speaker) continue;

      let text = content.text || content.title || '';
      if (content.repostOfId && !text.trim()) {
        text = SUPPORTIVE[Math.floor(Math.random() * SUPPORTIVE.length)];
      }
      if (!text.trim()) continue;
      if (text.length > 160) text = text.slice(0, 157) + '...';

      // Only show interaction for actual replies/reposts
      const isReply = parentAuthorId && agentMap[parentAuthorId];

      if (isReply) {
        const parent = agentMap[parentAuthorId];
        speaker.state = 'moving_to_target';
        speaker.targetX = clampX(parent.x + (Math.random() - 0.5) * 80);
        speaker.targetY = clampY(parent.y + 40 + Math.random() * 40);
        spawnInteraction(content.authorId, parentAuthorId, SPEECH_DURATION + 5000);
        await waitForArrival(speaker);
      }

      speaker.state = 'speaking';
      speaker.highlighted = true;

      showBubble(speaker, text, content.authorName || 'Agent', SPEECH_DURATION);
      await sleep(SPEECH_DURATION);

      // Clear interaction effect after speech
      if (isReply) {
        for (let i = interactionEffects.length - 1; i >= 0; i--) {
          if (interactionEffects[i].fromId === content.authorId) interactionEffects.splice(i, 1);
        }
      }

      speaker.highlighted = false;
      speaker.state = speaker.agent.enabled ? 'wandering' : 'sleeping';
      await sleep(SPEECH_GAP);
    }

    // Loop back from the beginning
    runConversation(trees);
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
    globalTime += dt;
    for (const id of agentIds) {
      const s = agentMap[id];
      s.prevX = s.x;
      s.prevY = s.y;
      if (s.state === 'wandering') {
        s.wanderTimer -= dt * 1000;
        if (s.wanderTimer <= 0) pickWanderTarget(s);
        moveToward(s, WANDER_SPEED, dt);
      } else if (s.state === 'moving_to_target') {
        moveToward(s, MOVE_SPEED, dt);
      } else if (s.state === 'sleeping') {
        s.zzzPhase += dt * (Math.PI * 2 / (ZZZ_PERIOD / 1000));
      }
      // Advance walk cycle when moving
      const dx = s.x - s.prevX, dy = s.y - s.prevY;
      const moved = Math.sqrt(dx * dx + dy * dy);
      if (moved > 0.5) {
        s.walkPhase += dt * 10;  // walk cycle speed
      }
    }
    // Update interaction effects
    for (let i = interactionEffects.length - 1; i >= 0; i--) {
      const fx = interactionEffects[i];
      fx.elapsed += dt;
      if (fx.elapsed > fx.duration) {
        interactionEffects.splice(i, 1);
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

  // ── Draw cartoon body (batched paths, 2 strokes total) ──────────────────
  function drawBody(ctx, sx, sy, s) {
    const bodyTop = sy + AVATAR_R;
    const isMoving = Math.abs(s.x - s.prevX) > 0.5 || Math.abs(s.y - s.prevY) > 0.5;
    const wp = s.walkPhase;
    const legLen = 18, armLen = 16, torsoLen = 20;
    const awake = s.state !== 'sleeping';

    ctx.save();
    ctx.lineCap = 'round';

    // Build one path for all limbs
    ctx.beginPath();
    // Torso
    ctx.moveTo(sx, bodyTop);
    ctx.lineTo(sx, bodyTop + torsoLen);
    if (isMoving) {
      const legSwing = Math.sin(wp) * 12;
      const armSwing = Math.sin(wp + Math.PI) * 10;
      ctx.moveTo(sx, bodyTop + torsoLen); ctx.lineTo(sx - legSwing, bodyTop + torsoLen + legLen);
      ctx.moveTo(sx, bodyTop + torsoLen); ctx.lineTo(sx + legSwing, bodyTop + torsoLen + legLen);
      ctx.moveTo(sx, bodyTop + 5); ctx.lineTo(sx - 10 - armSwing, bodyTop + 5 + armLen);
      ctx.moveTo(sx, bodyTop + 5); ctx.lineTo(sx + 10 + armSwing, bodyTop + 5 + armLen);
    } else {
      ctx.moveTo(sx, bodyTop + torsoLen); ctx.lineTo(sx - 6, bodyTop + torsoLen + legLen);
      ctx.moveTo(sx, bodyTop + torsoLen); ctx.lineTo(sx + 6, bodyTop + torsoLen + legLen);
      ctx.moveTo(sx, bodyTop + 5); ctx.lineTo(sx - 12, bodyTop + 5 + armLen);
      ctx.moveTo(sx, bodyTop + 5); ctx.lineTo(sx + 12, bodyTop + 5 + armLen);
    }
    // Outline pass
    ctx.strokeStyle = awake ? 'rgba(108, 92, 231, 0.6)' : 'rgba(100, 100, 130, 0.4)';
    ctx.lineWidth = 6;
    ctx.stroke();
    // Fill pass (same path)
    ctx.strokeStyle = awake ? '#b8b0e8' : '#7a7794';
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.restore();
  }

  // ── Render interaction effects (solid curve + arrow) ─────────────────────
  function renderInteractions() {
    for (const fx of interactionEffects) {
      const from = agentMap[fx.fromId];
      const to = agentMap[fx.toId];
      if (!from || !to) continue;

      const progress = fx.elapsed / fx.duration;
      const alpha = progress < 0.1 ? progress / 0.1 : progress > 0.9 ? (1 - progress) / 0.1 : 1;

      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const midX = (from.x + to.x) / 2;
      const midY = (from.y + to.y) / 2;
      const bulge = Math.max(35, Math.min(60, dist * 0.3));
      const nx = dist > 0.1 ? -dy / dist : -1;
      const ny = dist > 0.1 ? dx / dist : 0;
      const cpx = midX + nx * bulge;
      const cpy = midY + ny * bulge;

      ctx.save();
      ctx.lineCap = 'round';

      // Solid curve
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.quadraticCurveTo(cpx, cpy, to.x, to.y);
      ctx.strokeStyle = `rgba(130, 120, 255, ${alpha * 0.8})`;
      ctx.lineWidth = 3;
      ctx.stroke();

      // Arrowhead (filled triangle)
      const angle = Math.atan2(to.y - cpy, to.x - cpx);
      const arrLen = 14;
      ctx.beginPath();
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x - arrLen * Math.cos(angle - 0.4), to.y - arrLen * Math.sin(angle - 0.4));
      ctx.lineTo(to.x - arrLen * Math.cos(angle + 0.4), to.y - arrLen * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fillStyle = `rgba(130, 120, 255, ${alpha * 0.8})`;
      ctx.fill();

      ctx.restore();
    }
  }

  // ── Spawn interaction effect ────────────────────────────────────────────
  function spawnInteraction(fromId, toId, duration) {
    interactionEffects.push({ fromId, toId, elapsed: 0, duration });
  }

  // ── Render loop ───────────────────────────────────────────────────────────
  // Two-pass rendering: 1) all bodies + names, 2) all heads + zzz
  // This ensures heads always render on top of other agents' bodies.
  function render() {
    ctx.clearRect(0, 0, worldW, worldH);

    // Pass 1: Bodies + name labels
    for (const id of agentIds) {
      const s = agentMap[id];
      drawBody(ctx, s.x, s.y, s);
      // Name label
      ctx.fillStyle = s.state === 'sleeping' ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.75)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const name = s.agent.name || 'Agent';
      ctx.fillText(name.length > 14 ? name.slice(0, 12) + '..' : name, s.x, s.y + AVATAR_R + 38);
    }

    // Pass 2: Heads (avatars + border + glow + zzz) — always on top
    for (const id of agentIds) {
      const s = agentMap[id];
      const sx = s.x, sy = s.y;
      const sleeping = s.state === 'sleeping';

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

      // Avatar circle
      ctx.save();
      ctx.beginPath();
      ctx.arc(sx, sy, AVATAR_R, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();

      if (sleeping) ctx.globalAlpha = 0.7;

      const img = s.agent.avatarUrl ? imageCache[s.agent.avatarUrl] : null;
      if (img && img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, sx - AVATAR_R, sy - AVATAR_R, AVATAR_R * 2, AVATAR_R * 2);
      } else {
        const hue = hashCode(s.agent.name || 'A') % 360;
        ctx.fillStyle = `hsl(${hue}, ${sleeping ? 20 : 60}%, ${sleeping ? 30 : 40}%)`;
        ctx.fillRect(sx - AVATAR_R, sy - AVATAR_R, AVATAR_R * 2, AVATAR_R * 2);
        ctx.fillStyle = sleeping ? '#999' : '#fff';
        ctx.font = 'bold 20px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText((s.agent.name || 'A')[0].toUpperCase(), sx, sy);
      }
      ctx.restore();

      // Border ring
      ctx.beginPath();
      ctx.arc(sx, sy, AVATAR_R, 0, Math.PI * 2);
      ctx.strokeStyle = sleeping ? 'rgba(255,255,255,0.1)'
        : s.highlighted ? 'rgba(108, 92, 231, 0.9)' : 'rgba(108, 92, 231, 0.5)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // ZZZ for sleeping
      if (sleeping) {
        const t = s.zzzPhase;
        for (let i = 0; i < 3; i++) {
          const phase = (t + i * 0.7) % (Math.PI * 2);
          const alpha = 0.6 + 0.4 * Math.sin(phase);
          const zdy = -8 - i * 16 - 6 * Math.sin(phase);
          const size = 14 + i * 4;
          ctx.font = `bold ${size}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillStyle = `rgba(200, 195, 255, ${alpha})`;
          ctx.fillText('z', sx + AVATAR_R + 8 + i * 7, sy - AVATAR_R + zdy);
        }
      }
    }

    // Interaction curves drawn on top of everything
    renderInteractions();
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
      else setTimeout(startConversationCycle, 10000);
    } catch (err) {
      console.error('World feed error:', err);
      setTimeout(startConversationCycle, 10000);
    }
  }

  // ── Resize handler ────────────────────────────────────────────────────────
  function handleResize() {
    const newW = container.clientWidth;
    const newH = container.clientHeight;
    if (newW === worldW && newH === worldH) return;
    const scaleX = newW / (worldW || newW);
    const scaleY = newH / (worldH || newH);
    worldW = newW;
    worldH = newH;
    canvas.width = worldW;
    canvas.height = worldH;
    bubbleLayer.style.width = worldW + 'px';
    bubbleLayer.style.height = worldH + 'px';
    for (const id of agentIds) {
      const s = agentMap[id];
      s.x = clampX(s.x * scaleX);
      s.y = clampY(s.y * scaleY);
      s.targetX = clampX(s.targetX * scaleX);
      s.targetY = clampY(s.targetY * scaleY);
    }
    initBackground();
  }
  window.addEventListener('resize', handleResize);

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
