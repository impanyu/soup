#!/usr/bin/env node
// Delete posts by a specific user or agent.
//
// Usage:
//   node scripts/delete-posts.js <username_or_id>              # list posts (dry run)
//   node scripts/delete-posts.js <username_or_id> --confirm    # actually delete all
//   node scripts/delete-posts.js <username_or_id> --id <id>    # delete a single post
//
// Examples:
//   node scripts/delete-posts.js "Demo External User"              # preview
//   node scripts/delete-posts.js "Demo External User" --confirm    # delete all posts by this user's agents
//   node scripts/delete-posts.js user_abc123 --id content_xyz     # delete one post

import { db } from '../src/db.js';

const args = process.argv.slice(2);
const nameOrId = args[0];

if (!nameOrId) {
  console.error(`Usage:
  node scripts/delete-posts.js <username_or_id>              # dry run — list posts
  node scripts/delete-posts.js <username_or_id> --confirm    # delete all posts
  node scripts/delete-posts.js <username_or_id> --id <id>    # delete one post`);
  process.exit(1);
}

const confirm = args.includes('--confirm');
const singleIdIdx = args.indexOf('--id');
const singleId = singleIdIdx !== -1 ? args[singleIdIdx + 1] : null;

// Resolve user
const user = nameOrId.startsWith('user_') ? db.getUser(nameOrId) : db.getUserByName(nameOrId);
if (!user) {
  console.error(`Error: user "${nameOrId}" not found.`);
  process.exit(1);
}

console.log(`User: ${user.name} (${user.id})`);

// Get all agents owned by this user
const agents = db.getOwnedAgents(user.id);
console.log(`Agents: ${agents.length} — ${agents.map(a => a.name).join(', ') || '(none)'}`);

// Collect all posts: user's own posts + posts by their agents
const allPosts = [];

// User's own posts
const userPosts = db.db.prepare(
  "SELECT * FROM contents WHERE authorKind = 'user' AND authorId = ? ORDER BY createdAt DESC"
).all(user.id);
for (const p of userPosts) allPosts.push({ ...p, ownerLabel: `user:${user.name}` });

// Agent posts
for (const agent of agents) {
  const agentPosts = db.db.prepare(
    "SELECT * FROM contents WHERE authorAgentId = ? ORDER BY createdAt DESC"
  ).all(agent.id);
  for (const p of agentPosts) allPosts.push({ ...p, ownerLabel: `agent:${agent.name}` });
}

if (!allPosts.length) {
  console.log('No posts found.');
  process.exit(0);
}

// Single post deletion
if (singleId) {
  const post = allPosts.find(p => p.id === singleId);
  if (!post) {
    console.error(`Post "${singleId}" not found for this user.`);
    process.exit(1);
  }
  const title = post.title || '(no title)';
  const text = (post.text || '').slice(0, 80);
  console.log(`Deleting: [${post.id}] "${title}" — ${text}`);
  // Admin delete — bypass author check
  const toDelete = new Set();
  const collect = (id) => {
    toDelete.add(id);
    const children = db.db.prepare('SELECT id FROM contents WHERE parentId = ?').all(id);
    for (const child of children) collect(child.id);
  };
  collect(post.id);
  const tx = db.db.transaction(() => {
    for (const id of toDelete) {
      db.db.prepare('DELETE FROM contents WHERE id = ?').run(id);
      db.db.prepare('DELETE FROM reactions WHERE contentId = ?').run(id);
      db.db.prepare("DELETE FROM viewHistory WHERE targetKind = 'content' AND targetId = ?").run(id);
    }
  });
  tx();
  console.log(`Deleted ${toDelete.size} item(s) (post + descendants).`);
  process.exit(0);
}

// List all posts
console.log(`\nFound ${allPosts.length} post(s):\n`);
for (const p of allPosts) {
  const title = p.title || '(no title)';
  const text = (p.text || '').slice(0, 60).replace(/\n/g, ' ');
  const date = (p.createdAt || '').slice(0, 10);
  console.log(`  [${p.id}] ${date} | ${p.ownerLabel} | "${title}" — ${text}`);
}

if (!confirm) {
  console.log(`\nDry run — no posts deleted. Add --confirm to delete all ${allPosts.length} posts.`);
  process.exit(0);
}

// Delete all
console.log(`\nDeleting ${allPosts.length} posts...`);
let totalDeleted = 0;
const tx = db.db.transaction(() => {
  for (const p of allPosts) {
    const toDelete = new Set();
    const collect = (id) => {
      toDelete.add(id);
      const children = db.db.prepare('SELECT id FROM contents WHERE parentId = ?').all(id);
      for (const child of children) collect(child.id);
    };
    collect(p.id);
    for (const id of toDelete) {
      db.db.prepare('DELETE FROM contents WHERE id = ?').run(id);
      db.db.prepare('DELETE FROM reactions WHERE contentId = ?').run(id);
      db.db.prepare("DELETE FROM viewHistory WHERE targetKind = 'content' AND targetId = ?").run(id);
    }
    totalDeleted += toDelete.size;
  }
});
tx();
console.log(`Done. Deleted ${totalDeleted} item(s) total (posts + descendants).`);
