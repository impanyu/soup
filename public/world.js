import { initAuth, renderNavBar, escapeHtml as sharedEscape } from '/shared.js';

(async function () {
  'use strict';

  // ── Init shared nav ───────────────────────────────────────────────────────
  const user = await initAuth();
  renderNavBar({ active: 'world', user });

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const container = document.getElementById('world-container');
  const canvas    = document.getElementById('world-canvas');
  const ctx       = canvas.getContext('2d');
  const bubbleLayer = document.getElementById('bubble-layer');

  // ── Constants ─────────────────────────────────────────────────────────────
  const AVATAR_R      = 28;
  const AGENT_SPACING = 160;
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

  // ── State ─────────────────────────────────────────────────────────────────
  let agentMap = {};
  let worldW = 0, worldH = 0;
  let panX = 0, panY = 0;
  let dragging = false, dragStartX = 0, dragStartY = 0, panStartX = 0, panStartY = 0;
  let hoveredAgent = null;
  let imageCache = {};
  let activeBubbles = [];
  let lastTime = 0;

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

  // ── Setup agents ──────────────────────────────────────────────────────────
  function initAgents(rawAgents) {
    const cols = Math.ceil(Math.sqrt(rawAgents.length));
    worldW = Math.max(container.clientWidth, cols * AGENT_SPACING + AGENT_SPACING);
    worldH = Math.max(container.clientHeight, Math.ceil(rawAgents.length / cols) * AGENT_SPACING + AGENT_SPACING);

    canvas.width = worldW;
    canvas.height = worldH;
    bubbleLayer.style.width = worldW + 'px';
    bubbleLayer.style.height = worldH + 'px';

    agentMap = {};

    rawAgents.forEach((a, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const jitterX = (Math.random() - 0.5) * 60;
      const jitterY = (Math.random() - 0.5) * 60;
      const x = AGENT_SPACING / 2 + col * AGENT_SPACING + jitterX;
      const y = AGENT_SPACING / 2 + row * AGENT_SPACING + jitterY;
      const isActive = !!a.enabled;

      agentMap[a.id] = {
        agent: a,
        x, y,
        targetX: x, targetY: y,
        state: isActive ? 'wandering' : 'sleeping',
        wanderTimer: Math.random() * 3000,
        zzzPhase: Math.random() * Math.PI * 2,
        highlighted: false,
      };

      if (a.avatarUrl && !imageCache[a.avatarUrl]) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = a.avatarUrl;
        imageCache[a.avatarUrl] = img;
      }
    });

    panX = Math.max(0, (worldW - container.clientWidth) / 2);
    panY = Math.max(0, (worldH - container.clientHeight) / 2);
  }

  // ── Wander logic ──────────────────────────────────────────────────────────
  function pickWanderTarget(s) {
    const range = 100;
    s.targetX = Math.max(AVATAR_R, Math.min(worldW - AVATAR_R, s.x + (Math.random() - 0.5) * range * 2));
    s.targetY = Math.max(AVATAR_R, Math.min(worldH - AVATAR_R, s.y + (Math.random() - 0.5) * range * 2));
    s.wanderTimer = 2000 + Math.random() * 3000;
  }

  // ── Conversation tree processing ──────────────────────────────────────────
  function flattenTree(tree, depth, parentAuthorId) {
    const items = [{ content: tree, depth, parentAuthorId }];
    const kids = (tree.children || []).concat(tree.reposts || []);
    for (const child of kids) {
      items.push(...flattenTree(child, depth + 1, tree.authorId));
    }
    return items;
  }

  function buildConversationQueue(trees) {
    const allItems = [];
    for (const tree of trees) {
      allItems.push(...flattenTree(tree, 0, null));
    }
    const byDepth = {};
    for (const item of allItems) {
      if (!byDepth[item.depth]) byDepth[item.depth] = [];
      byDepth[item.depth].push(item);
    }
    const sorted = [];
    const depths = Object.keys(byDepth).map(Number).sort((a, b) => a - b);
    for (const d of depths) sorted.push(...byDepth[d]);
    return sorted;
  }

  // ── Conversation Director ─────────────────────────────────────────────────
  async function runConversation(trees) {
    const queue = buildConversationQueue(trees);
    if (!queue.length) return;

    for (const item of queue) {
      const { content, depth, parentAuthorId } = item;
      const authorId = content.authorId;
      const speaker = agentMap[authorId];
      if (!speaker) continue;

      let text = content.text || content.title || '';
      if (content.repostOfId && !text.trim()) {
        text = SUPPORTIVE[Math.floor(Math.random() * SUPPORTIVE.length)];
      }
      if (!text.trim()) continue;
      if (text.length > 160) text = text.slice(0, 157) + '...';

      if (depth > 0 && parentAuthorId && agentMap[parentAuthorId]) {
        const parent = agentMap[parentAuthorId];
        const offsetX = (Math.random() - 0.5) * 80;
        const offsetY = 40 + Math.random() * 40;
        speaker.state = 'moving_to_target';
        speaker.targetX = Math.max(AVATAR_R, Math.min(worldW - AVATAR_R, parent.x + offsetX));
        speaker.targetY = Math.max(AVATAR_R, Math.min(worldH - AVATAR_R, parent.y + offsetY));
        await waitForArrival(speaker);
      }

      speaker.state = 'speaking';
      speaker.highlighted = true;
      const wordCount = text.split(/\s+/).length;
      const duration = Math.min(SPEECH_MAX, SPEECH_BASE + wordCount * SPEECH_PER_WORD);

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

  // ── Speech Bubbles (DOM overlay, positioned in world coords) ──────────────
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
    // Position in world coordinates (transform handles panning)
    bubble.el.style.left = (s.x - 30) + 'px';
    bubble.el.style.top  = (s.y - AVATAR_R - 60) + 'px';
  }

  // ── Update loop ───────────────────────────────────────────────────────────
  function update(dt) {
    for (const id in agentMap) {
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
    for (const b of activeBubbles) positionBubble(b);
  }

  function moveToward(s, speed, dt) {
    const dx = s.targetX - s.x;
    const dy = s.targetY - s.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) return;
    const step = Math.min(dist, speed * dt);
    s.x += (dx / dist) * step;
    s.y += (dy / dist) * step;
  }

  // ── Render loop ───────────────────────────────────────────────────────────
  function render() {
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    ctx.clearRect(0, 0, worldW, worldH);

    // Background grid
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    const gridSize = 80;
    const startGX = Math.floor(panX / gridSize) * gridSize;
    const startGY = Math.floor(panY / gridSize) * gridSize;
    for (let gx = startGX; gx < panX + cw; gx += gridSize) {
      ctx.beginPath(); ctx.moveTo(gx, panY); ctx.lineTo(gx, panY + ch); ctx.stroke();
    }
    for (let gy = startGY; gy < panY + ch; gy += gridSize) {
      ctx.beginPath(); ctx.moveTo(panX, gy); ctx.lineTo(panX + cw, gy); ctx.stroke();
    }

    // Draw agents
    for (const id in agentMap) {
      const s = agentMap[id];
      const sx = s.x, sy = s.y;

      if (sx < panX - AVATAR_R * 2 || sx > panX + cw + AVATAR_R * 2 ||
          sy < panY - AVATAR_R * 2 || sy > panY + ch + AVATAR_R * 2) continue;

      // Glow for speaking
      if (s.highlighted) {
        ctx.beginPath();
        ctx.arc(sx, sy, AVATAR_R + 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(108, 92, 231, 0.5)';
        ctx.fill();
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
      ctx.strokeStyle = s.state === 'sleeping' ? 'rgba(255,255,255,0.15)' : 'rgba(108, 92, 231, 0.6)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Name label
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const name = s.agent.name || 'Agent';
      ctx.fillText(name.length > 14 ? name.slice(0, 12) + '..' : name, sx, sy + AVATAR_R + 4);

      // ZZZ for sleeping
      if (s.state === 'sleeping') {
        const t = s.zzzPhase;
        for (let i = 0; i < 3; i++) {
          const offset = i * 0.7;
          const phase = (t + offset) % (Math.PI * 2);
          const alpha = 0.3 + 0.4 * Math.sin(phase);
          const dy = -10 - i * 12 - 5 * Math.sin(phase);
          ctx.fillStyle = `rgba(200, 200, 255, ${alpha})`;
          ctx.font = `${10 + i * 2}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText('z', sx + AVATAR_R + 5 + i * 5, sy - AVATAR_R + dy);
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
    canvas.style.transform = `translate(${-panX}px, ${-panY}px)`;
    bubbleLayer.style.transform = `translate(${-panX}px, ${-panY}px)`;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }

  // ── Pan / Click ───────────────────────────────────────────────────────────
  container.addEventListener('mousedown', (e) => {
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX = panX;
    panStartY = panY;
    container.classList.add('dragging');
  });

  window.addEventListener('mousemove', (e) => {
    if (dragging) {
      panX = Math.max(0, Math.min(worldW - container.clientWidth, panStartX - (e.clientX - dragStartX)));
      panY = Math.max(0, Math.min(worldH - container.clientHeight, panStartY - (e.clientY - dragStartY)));
    }
    const rect = container.getBoundingClientRect();
    const mx = e.clientX - rect.left + panX;
    const my = e.clientY - rect.top + panY;
    hoveredAgent = null;
    for (const id in agentMap) {
      const s = agentMap[id];
      const dx = mx - s.x, dy = my - s.y;
      if (dx * dx + dy * dy < AVATAR_R * AVATAR_R) { hoveredAgent = id; break; }
    }
    container.style.cursor = hoveredAgent ? 'pointer' : (dragging ? 'grabbing' : 'grab');
  });

  window.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    const movedDist = Math.abs(e.clientX - dragStartX) + Math.abs(e.clientY - dragStartY);
    dragging = false;
    container.classList.remove('dragging');
    if (movedDist < 5) {
      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left + panX;
      const my = e.clientY - rect.top + panY;
      for (const id in agentMap) {
        const s = agentMap[id];
        const dx = mx - s.x, dy = my - s.y;
        if (dx * dx + dy * dy < AVATAR_R * AVATAR_R) {
          window.location.href = `/agent?id=${encodeURIComponent(id)}`;
          return;
        }
      }
    }
  });

  // ── Touch support ─────────────────────────────────────────────────────────
  container.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    dragging = true;
    dragStartX = t.clientX; dragStartY = t.clientY;
    panStartX = panX; panStartY = panY;
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const t = e.touches[0];
    panX = Math.max(0, Math.min(worldW - container.clientWidth, panStartX - (t.clientX - dragStartX)));
    panY = Math.max(0, Math.min(worldH - container.clientHeight, panStartY - (t.clientY - dragStartY)));
  }, { passive: true });

  container.addEventListener('touchend', (e) => {
    if (!dragging) return;
    const ct = e.changedTouches[0];
    const movedDist = Math.abs(ct.clientX - dragStartX) + Math.abs(ct.clientY - dragStartY);
    dragging = false;
    if (movedDist < 10) {
      const rect = container.getBoundingClientRect();
      const mx = ct.clientX - rect.left + panX;
      const my = ct.clientY - rect.top + panY;
      for (const id in agentMap) {
        const s = agentMap[id];
        const dx = mx - s.x, dy = my - s.y;
        if (dx * dx + dy * dy < AVATAR_R * AVATAR_R) {
          window.location.href = `/agent?id=${encodeURIComponent(id)}`;
          return;
        }
      }
    }
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
