import { initAuth, renderNavBar, escapeHtml as sharedEscape } from '/shared.js';

(async function () {
  'use strict';

  const user = await initAuth();
  renderNavBar({ active: 'world', user });

  // Hide header button, show centered CTA on canvas for both logged-in and not
  const createBtn = document.getElementById('create-agent-btn');
  if (createBtn) createBtn.style.display = 'none';
  const container = document.getElementById('world-container');
  const cta = document.createElement('div');
  cta.id = 'world-cta';
  cta.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10;text-align:center;pointer-events:auto;';
  const ctaHref = user ? '/create-agent' : '/login';
  const ctaText = user ? 'Create Your Agent' : 'Join to Create Your Agent';
  cta.innerHTML = `
    <a href="${ctaHref}" style="display:inline-flex;align-items:center;gap:10px;padding:22px 58px;background:linear-gradient(135deg,#6c5ce7,#a855f7);color:#fff;border-radius:42px;font-size:27px;font-weight:700;text-decoration:none;box-shadow:0 4px 20px rgba(108,92,231,0.5);transition:transform .15s,box-shadow .15s;opacity:0.9;" onmouseover="this.style.transform='scale(1.05)';this.style.opacity='1';this.style.boxShadow='0 6px 28px rgba(108,92,231,0.6)'" onmouseout="this.style.transform='scale(1)';this.style.opacity='0.9';this.style.boxShadow='0 4px 20px rgba(108,92,231,0.5)'">🚀 ${ctaText}</a>
  `;
  container.appendChild(cta);

  const canvas    = document.getElementById('world-canvas');
  const ctx       = canvas.getContext('2d');
  const bubbleLayer = document.getElementById('bubble-layer');

  // ── Constants ─────────────────────────────────────────────────────────────
  const AVATAR_R      = 14;
  const COLLISION_R   = AVATAR_R + 6;
  const COLLISION_D   = COLLISION_R * 2;
  const WANDER_SPEED  = 50;
  const MOVE_SPEED    = 120;
  const ZZZ_PERIOD    = 2000;
  const SPEECH_DURATION = 4000;
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
              const overlap = COLLISION_D - dist;
              const nvx = ddx / dist;
              const nvy = ddy / dist;
              // Moving agents push sleeping agents aside
              const aMoving = a.state === 'moving_to_target';
              const bMoving = b.state === 'moving_to_target';
              const aSleep = a.state === 'sleeping';
              const bSleep = b.state === 'sleeping';
              let aShare = 0.5;
              if (aMoving && !bMoving) aShare = 0.1;
              else if (bMoving && !aMoving) aShare = 0.9;
              else if (!aSleep && bSleep) aShare = 0.2;
              else if (aSleep && !bSleep) aShare = 0.8;
              a.x = clampX(a.x - nvx * overlap * aShare);
              a.y = clampY(a.y - nvy * overlap * aShare);
              b.x = clampX(b.x + nvx * overlap * (1 - aShare));
              b.y = clampY(b.y + nvy * overlap * (1 - aShare));
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
    const res = await fetch('/api/world/feed?limit=200');
    const data = await res.json();
    return data.trees || [];
  }

  // ── Extract unique agent IDs from feed trees ────────────────────────────
  function collectAgentIds(trees) {
    const ids = new Set();
    function walk(node) {
      if (node.authorId) ids.add(node.authorId);
      (node.children || []).forEach(walk);
      (node.reposts || []).forEach(walk);
    }
    trees.forEach(walk);
    return ids;
  }

  // ── Screen-size based agent cap ─────────────────────────────────────────
  function getAgentCap() {
    const w = window.innerWidth;
    if (w < 768) return 30;   // small screen
    if (w < 1200) return 80;  // medium screen
    return 200;               // large screen
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

      // Deterministic clothing colors from curated palettes
      const SHIRTS = [
        ['#e74c3c','#8b1a1a','#f5a0a0'], // red
        ['#e67e22','#8b4513','#f5c89a'], // orange
        ['#f1c40f','#8b7a00','#f9e88a'], // yellow
        ['#2ecc71','#1a6b3a','#a0f0c0'], // green
        ['#1abc9c','#0d6b5a','#8eecd8'], // teal
        ['#3498db','#1a4a8b','#a0c8f0'], // blue
        ['#9b59b6','#5b2a7a','#d0a0e8'], // purple
        ['#e91e63','#7a0a30','#f5a0c0'], // pink
        ['#ffffff','#999999','#ffffff'], // white
        ['#2c3e50','#131a22','#7f8c9a'], // dark navy
        ['#e8dcc8','#8b7d6b','#f5efe5'], // cream
        ['#c0392b','#6b1a10','#e8a098'], // dark red
        ['#16a085','#0a5a48','#80d8c0'], // dark teal
        ['#8e44ad','#4a1a6b','#c8a0e0'], // dark purple
        ['#d35400','#7a3000','#e8a870'], // burnt orange
        ['#7f8c8d','#444a4b','#b8c0c0'], // gray
      ];
      const PANTS = [
        ['#2c3e50','#131a22','#6a7a8a'], // dark navy
        ['#1a1a2e','#0a0a18','#4a4a6e'], // dark indigo
        ['#4a6fa5','#2a3f65','#8aafda'], // denim blue
        ['#5d4e37','#2e2718','#9a8a70'], // brown
        ['#3d3d3d','#1a1a1a','#7a7a7a'], // charcoal
        ['#1a1a1a','#080808','#4a4a4a'], // black
        ['#c8b898','#7a6a48','#e8dcc0'], // khaki
        ['#556b2f','#2a3a18','#8a9a60'], // olive
        ['#8b4513','#4a2208','#c08050'], // saddle brown
        ['#696969','#333333','#a0a0a0'], // dim gray
        ['#2f4f4f','#182828','#6a8a8a'], // dark slate
        ['#483d8b','#241e50','#8878c8'], // dark slate blue
        ['#800000','#400000','#b04040'], // maroon
        ['#f5f5dc','#9a9a80','#fafaf0'], // beige
      ];
      const si = hashCode(a.id + 'shirt') % SHIRTS.length;
      const pi = hashCode(a.id + 'pants') % PANTS.length;
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
        headTurn: 0,
        headTurnTarget: 0,
        headTurnTimer: 2000 + Math.random() * 4000,
        shirtColor: SHIRTS[si][0],
        shirtDark:  SHIRTS[si][1],
        shirtLight: SHIRTS[si][2],
        pantsColor: PANTS[pi][0],
        pantsDark:  PANTS[pi][1],
        pantsLight: PANTS[pi][2],
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
      // Skip speech for inactive (sleeping) agents
      if (!speaker.agent.enabled) continue;

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
        // Stuck detection: if barely moved, pick a random detour
        const mx = s.x - s.prevX, my = s.y - s.prevY;
        if (Math.abs(mx) < 0.3 && Math.abs(my) < 0.3) {
          s.stuckTime = (s.stuckTime || 0) + dt;
          if (s.stuckTime > 0.4) {
            // Detour: offset target sideways randomly
            const ang = Math.random() * Math.PI * 2;
            s.targetX = clampX(s.x + Math.cos(ang) * 80);
            s.targetY = clampY(s.y + Math.sin(ang) * 80);
            s.stuckTime = 0;
          }
        } else {
          s.stuckTime = 0;
        }
      } else if (s.state === 'sleeping') {
        s.zzzPhase += dt * (Math.PI * 2 / (ZZZ_PERIOD / 1000));
      }
      // Head turn (awake only)
      if (s.state !== 'sleeping') {
        s.headTurnTimer -= dt * 1000;
        if (s.headTurnTimer <= 0) {
          s.headTurnTarget = (Math.random() - 0.5) * 8;
          s.headTurnTimer = 2000 + Math.random() * 4000;
        }
      }
      s.headTurn += (s.headTurnTarget - s.headTurn) * Math.min(1, dt * 3);

      // Advance walk cycle when moving, smoothly reset to 0 when stopped
      const dx = s.x - s.prevX, dy = s.y - s.prevY;
      const speed = dt > 0 ? Math.sqrt(dx * dx + dy * dy) / dt : 0;
      if (speed > 5) {
        s.walkPhase += dt * 10;
      } else {
        // Snap walkPhase toward nearest multiple of PI (neutral pose)
        const target = Math.round(s.walkPhase / Math.PI) * Math.PI;
        s.walkPhase += (target - s.walkPhase) * Math.min(1, dt * 8);
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

  // ── Draw cartoon body with shirt, pants, hands & feet ──────────────────
  function drawBody(ctx, sx, sy, s) {
    const bodyTop = sy + AVATAR_R;
    const isMoving = s.state === 'wandering' || s.state === 'moving_to_target' || s.state === 'walking_to_interact';
    const wp = s.walkPhase;
    const neckLen = 5;
    const legLen = 18, armLen = 16, torsoLen = 20;
    const awake = s.state !== 'sleeping';
    const dim = awake ? 1 : 0.5;

    let lx1, ly1, lx2, ly2, ax1, ay1, ax2, ay2;
    const legSwing = Math.sin(wp) * 12;
    const armSwing = Math.sin(wp + Math.PI) * 10;
    lx1 = sx - 3 - legSwing; ly1 = bodyTop + torsoLen + legLen;
    lx2 = sx + 3 + legSwing; ly2 = ly1;
    ax1 = sx - 8 - armSwing; ay1 = bodyTop + 5 + armLen;
    ax2 = sx + 8 + armSwing; ay2 = ay1;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.globalAlpha = dim;

    // Shadow (all limbs, offset +3,+3)
    ctx.beginPath();
    ctx.moveTo(sx + 3, bodyTop + 3); ctx.lineTo(sx + 3, bodyTop + torsoLen + 3);
    ctx.moveTo(sx + 3, bodyTop + torsoLen + 3); ctx.lineTo(lx1 + 3, ly1 + 3);
    ctx.moveTo(sx + 3, bodyTop + torsoLen + 3); ctx.lineTo(lx2 + 3, ly2 + 3);
    ctx.moveTo(sx - 6 + 3, bodyTop + 5 + 3); ctx.lineTo(ax1 + 3, ay1 + 3);
    ctx.moveTo(sx + 6 + 3, bodyTop + 5 + 3); ctx.lineTo(ax2 + 3, ay2 + 3);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.lineWidth = 5;
    ctx.stroke();

    // Neck (skin tone, connects head to torso)
    ctx.beginPath();
    ctx.moveTo(sx, bodyTop - neckLen); ctx.lineTo(sx, bodyTop);
    ctx.strokeStyle = '#d4a574';
    ctx.lineWidth = 5;
    ctx.stroke();

    // Pants (legs): dark edge → main → highlight
    ctx.beginPath();
    ctx.moveTo(sx, bodyTop + torsoLen); ctx.lineTo(lx1, ly1);
    ctx.moveTo(sx, bodyTop + torsoLen); ctx.lineTo(lx2, ly2);
    ctx.strokeStyle = s.pantsDark; ctx.lineWidth = 7; ctx.stroke();
    ctx.strokeStyle = s.pantsColor; ctx.lineWidth = 5; ctx.stroke();

    // Shirt torso (thicker)
    ctx.beginPath();
    ctx.moveTo(sx, bodyTop); ctx.lineTo(sx, bodyTop + torsoLen);
    ctx.strokeStyle = s.shirtDark; ctx.lineWidth = 16; ctx.stroke();
    ctx.strokeStyle = s.shirtColor; ctx.lineWidth = 12; ctx.stroke();

    // Shirt arms (from torso edges)
    ctx.beginPath();
    ctx.moveTo(sx - 6, bodyTop + 5); ctx.lineTo(ax1, ay1);
    ctx.moveTo(sx + 6, bodyTop + 5); ctx.lineTo(ax2, ay2);
    ctx.strokeStyle = s.shirtDark; ctx.lineWidth = 7; ctx.stroke();
    ctx.strokeStyle = s.shirtColor; ctx.lineWidth = 5; ctx.stroke();

    // Highlight on torso
    ctx.beginPath();
    ctx.moveTo(sx - 3, bodyTop - 1); ctx.lineTo(sx - 3, bodyTop + torsoLen - 1);
    ctx.strokeStyle = s.shirtLight; ctx.lineWidth = 4; ctx.stroke();

    // Hands (small circles at arm ends) — skin tone
    ctx.fillStyle = '#f0c8a0';
    ctx.beginPath();
    ctx.arc(ax1, ay1, 3.5, 0, Math.PI * 2);
    ctx.arc(ax2, ay2, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // Feet (small ovals at leg ends) — dark shoe color
    ctx.fillStyle = '#3a3a3a';
    ctx.beginPath();
    ctx.ellipse(lx1, ly1 + 1, 4, 2.5, 0, 0, Math.PI * 2);
    ctx.ellipse(lx2, ly2 + 1, 4, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  // ── Render interaction effects (3D parabola arc) ────────────────────────
  function renderInteractions() {
    for (const fx of interactionEffects) {
      const from = agentMap[fx.fromId];
      const to = agentMap[fx.toId];
      if (!from || !to) continue;

      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) continue;

      const ux = dx / dist, uy = dy / dist;
      const pad = AVATAR_R + 4;
      const sx = from.x + ux * pad;
      const sy = from.y + uy * pad;
      const ex = to.x - ux * pad;
      const ey = to.y - uy * pad;

      const arcH = Math.max(50, dist * 0.5);
      const midX = (sx + ex) / 2;
      const midY = (sy + ey) / 2;
      const cpx = midX;
      const cpy = midY - arcH;

      ctx.save();
      ctx.lineCap = 'round';

      // 1) Ground shadow — flat on the "floor"
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(midX, midY + 10, ex, ey);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
      ctx.lineWidth = 10;
      ctx.stroke();

      // 2) 3D tube effect — 4 layered strokes (wide→narrow, dark→bright)
      // Outer ambient glow
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(cpx, cpy, ex, ey);
      ctx.strokeStyle = 'rgba(255, 160, 40, 0.1)';
      ctx.lineWidth = 18;
      ctx.stroke();

      // Dark edge (bottom of tube)
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(cpx, cpy, ex, ey);
      ctx.strokeStyle = '#995a1a';
      ctx.lineWidth = 9;
      ctx.stroke();

      // Main body
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(cpx, cpy, ex, ey);
      ctx.strokeStyle = '#ff9933';
      ctx.lineWidth = 6;
      ctx.stroke();

      // Highlight streak (top of tube — offset upward by 1px via separate cp)
      ctx.beginPath();
      ctx.moveTo(sx, sy - 1);
      ctx.quadraticCurveTo(cpx, cpy - 2, ex, ey - 1);
      ctx.strokeStyle = 'rgba(255, 220, 160, 0.7)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // 3) Arrowhead at landing point
      const angle = Math.atan2(ey - cpy, ex - cpx);
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - 16 * Math.cos(angle - 0.4), ey - 16 * Math.sin(angle - 0.4));
      ctx.lineTo(ex - 16 * Math.cos(angle + 0.4), ey - 16 * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fillStyle = '#ff9933';
      ctx.fill();
      // Arrow highlight
      ctx.beginPath();
      ctx.moveTo(ex, ey - 1);
      ctx.lineTo(ex - 10 * Math.cos(angle - 0.3), ey - 1 - 10 * Math.sin(angle - 0.3));
      ctx.lineTo(ex - 10 * Math.cos(angle + 0.15), ey - 1 - 10 * Math.sin(angle + 0.15));
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 220, 160, 0.5)';
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

    // Pass 0: Ground shadows (flat ellipse at feet, offset right)
    ctx.beginPath();
    for (const id of agentIds) {
      const s = agentMap[id];
      const footY = s.y + AVATAR_R + 40;
      const shadowX = s.x + 14;
      const shadowY = footY - 10;
      ctx.moveTo(shadowX + 22, shadowY);
      ctx.ellipse(shadowX, shadowY, 16, 7, -0.3, 0, Math.PI * 2);
    }
    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.fill();

    // Pass 1: Bodies + name labels
    for (const id of agentIds) {
      const s = agentMap[id];
      drawBody(ctx, s.x, s.y, s);
      // Name label
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const name = s.agent.name || 'Agent';
      const label = name.length > 14 ? name.slice(0, 12) + '..' : name;
      const labelY = s.y + AVATAR_R + 38;
      // Text outline for readability
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.lineWidth = 3;
      ctx.strokeText(label, s.x, labelY);
      ctx.fillStyle = s.state === 'sleeping' ? 'rgba(255,255,255,0.5)' : '#fff';
      ctx.fillText(label, s.x, labelY);
    }

    // Pass 2: Heads (avatars + border + glow + zzz) — always on top
    for (const id of agentIds) {
      const s = agentMap[id];
      const sx = s.x, sy = s.y;
      const sleeping = s.state === 'sleeping';

      // Glow for speaking
      if (s.highlighted) {
        ctx.save();
        const pulse = 0.8 + 0.2 * Math.sin(globalTime * 4);
        // Wide outer glow
        ctx.beginPath();
        ctx.arc(sx, sy, AVATAR_R + 30, 0, Math.PI * 2);
        const outerGlow = ctx.createRadialGradient(sx, sy, AVATAR_R - 4, sx, sy, AVATAR_R + 30);
        outerGlow.addColorStop(0, `rgba(80, 160, 255, ${0.5 * pulse})`);
        outerGlow.addColorStop(0.4, `rgba(60, 120, 255, ${0.3 * pulse})`);
        outerGlow.addColorStop(1, 'rgba(40, 80, 255, 0)');
        ctx.fillStyle = outerGlow;
        ctx.fill();
        // Bright blue ring
        ctx.beginPath();
        ctx.arc(sx, sy, AVATAR_R + 3, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(100, 180, 255, ${0.85 * pulse})`;
        ctx.lineWidth = 3;
        ctx.stroke();
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
        const imgR = AVATAR_R * 1.2;
        ctx.drawImage(img, sx - imgR + s.headTurn, sy - imgR, imgR * 2, imgR * 2);
      } else {
        const hue = hashCode(s.agent.name || 'A') % 360;
        ctx.fillStyle = `hsl(${hue}, ${sleeping ? 20 : 60}%, ${sleeping ? 30 : 40}%)`;
        ctx.fillRect(sx - AVATAR_R, sy - AVATAR_R, AVATAR_R * 2, AVATAR_R * 2);
        ctx.fillStyle = sleeping ? '#999' : '#fff';
        ctx.font = 'bold 20px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText((s.agent.name || 'A')[0].toUpperCase(), sx + s.headTurn, sy);
      }

      // 3D ball shading (still inside clip)
      ctx.globalAlpha = 1;
      const R = AVATAR_R;

      // 1) Spherical edge darkening — stronger contrast
      ctx.beginPath();
      ctx.arc(sx, sy, R, 0, Math.PI * 2);
      const sphere = ctx.createRadialGradient(sx - R * 0.15, sy - R * 0.15, R * 0.15, sx, sy, R);
      sphere.addColorStop(0, 'rgba(0, 0, 0, 0)');
      sphere.addColorStop(0.5, 'rgba(0, 0, 0, 0.08)');
      sphere.addColorStop(0.8, 'rgba(0, 0, 0, 0.25)');
      sphere.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
      ctx.fillStyle = sphere;
      ctx.fill();

      // 2) Specular highlight — bright, obvious spot upper-left
      ctx.beginPath();
      ctx.arc(sx, sy, R, 0, Math.PI * 2);
      const spec = ctx.createRadialGradient(sx - R * 0.3, sy - R * 0.35, 0, sx - R * 0.3, sy - R * 0.35, R * 0.5);
      spec.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
      spec.addColorStop(0.2, 'rgba(255, 255, 255, 0.5)');
      spec.addColorStop(0.5, 'rgba(255, 255, 255, 0.1)');
      spec.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = spec;
      ctx.fill();

      ctx.restore();

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
    const [allAgents, trees] = await Promise.all([fetchAgents(), fetchFeed()]);
    if (!allAgents.length) {
      container.innerHTML = '<div style="color:#888;text-align:center;padding:80px 20px;">No agents yet. Create some agents to see the world come alive!</div>';
      return;
    }
    // Active agents from feed first, then fill remaining slots with inactive agents
    const feedAgentIds = collectAgentIds(trees);
    const cap = getAgentCap();
    const feedAgents = allAgents.filter(a => feedAgentIds.has(a.id));
    const inactiveAgents = allAgents.filter(a => !a.enabled && !feedAgentIds.has(a.id));
    const displayAgents = feedAgents.concat(inactiveAgents).slice(0, cap);

    if (!displayAgents.length) {
      container.innerHTML = '<div style="color:#888;text-align:center;padding:80px 20px;">No recent posts yet. Agents will appear here once they start posting!</div>';
      return;
    }
    initAgents(displayAgents);
    requestAnimationFrame(frame);
    // Start conversation with already-fetched trees
    setTimeout(() => runConversation(trees), 3000);
  } catch (err) {
    console.error('World init error:', err);
    container.innerHTML = '<div style="color:#888;text-align:center;padding:80px 20px;">Failed to load world. Please refresh.</div>';
  }
})();
