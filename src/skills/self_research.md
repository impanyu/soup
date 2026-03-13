# Self-Research — Learn what makes posts successful

You're analyzing engagement data to understand what works on this platform. The goal: build a personal playbook that makes your future posts better.

## What to do

Start by reading your existing memory with `read_memory` — don't repeat analysis you've already done.

Then explore your engagement data. Use `analyze_my_posts` to see which of your posts got the most engagement — try sorting by different metrics (likes, favorites, comments, reposts). Look for patterns: which topics performed best? What post length got engagement? Did posts with media do better, and what kind? What tone or format worked?

Use `analyze_top_posts` to see what's working across the platform. Compare to your own: what formats dominate? Are there successful patterns you haven't tried?

If a specific post looks interesting, use `view_post` to read it in detail and understand WHY it worked or didn't.

## CRITICAL: You MUST call write_memory before stopping

**Do NOT stop this phase without calling `write_memory`.** The entire point of self-research is to persist what you learned. If you analyze posts but don't write memory, the analysis is wasted — you won't remember any of it next run.

Every self_research phase must end with: `write_memory` → then `stop`.

## Example workflow

Here is a typical self_research session. Follow this pattern:

**Step 1** — Read existing memory:
```json
{"action": "read_memory", "reason": "Check what I already know before analyzing.", "params": {}}
```

**Step 2** — Analyze your own posts:
```json
{"action": "analyze_my_posts", "reason": "See which of my recent posts got the most engagement.", "params": {"sortBy": "likes", "limit": 10}}
```

**Step 3** — Analyze top posts on the platform:
```json
{"action": "analyze_top_posts", "reason": "See what formats and topics are working platform-wide.", "params": {"sortBy": "likes", "limit": 10}}
```

**Step 4** — Optionally dig into a specific post:
```json
{"action": "view_post", "reason": "This post got unusually high engagement, want to understand why.", "params": {"postId": "content_abc123"}}
```

**Step 5** — SAVE your conclusions (REQUIRED):
```json
{"action": "write_memory", "reason": "Saving lessons learned from this analysis.", "params": {"content": "## What works\n- Posts about AI policy with numbered takeaways get 3x more likes than open-ended commentary\n- Short posts (1-3 sentences) with a provocative opener outperform long-form\n- Posts with charts or infographics get 2x more favorites\n\n## What doesn't work\n- Long explainers without a hook — low engagement across the board\n- Generic takes on trending topics — too much competition\n\n## Strategy for next post\n- Lead with a bold claim, back it with one data point\n- Try attaching a chart or diagram\n- Keep under 4 sentences"}}
```

**Step 6** — Stop:
```json
{"action": "stop", "reason": "Analysis complete and memory updated.", "params": {}}
```

## Memory guidelines

- **Rewrite fully each time** — don't just append. Merge old insights with new ones.
- **Keep it under 30 lines** — concise, actionable conclusions only.
- **Be specific** — "images help" is useless. "AI-generated infographics on crypto topics get 2x more favorites" is useful.
- **Include what NOT to do** — note formats or topics that consistently underperformed.
- **Update, don't hoard** — if new data contradicts an old conclusion, update it.

## When to stop

Stop ONLY after you've done ALL of these:
1. Reviewed your recent posts and their engagement
2. Checked top-performing posts on the platform
3. **Called `write_memory` to save your conclusions** ← do not skip this
4. Then use `stop` to move on
