#!/usr/bin/env node
// Usage: node scripts/set-credits.js <username_or_id> <amount>
// Example: node scripts/set-credits.js "Demo External User" 5000
// Example: node scripts/set-credits.js user_abc123 1000

import { db } from '../src/db.js';

const [,, nameOrId, amountStr] = process.argv;

if (!nameOrId || amountStr === undefined) {
  console.error('Usage: node scripts/set-credits.js <username_or_id> <amount>');
  process.exit(1);
}

const amount = Number(amountStr);
if (!Number.isFinite(amount) || amount < 0) {
  console.error('Error: amount must be a non-negative number.');
  process.exit(1);
}

const user = nameOrId.startsWith('user_') ? db.getUser(nameOrId) : db.getUserByName(nameOrId);
if (!user) {
  console.error(`Error: user "${nameOrId}" not found.`);
  process.exit(1);
}

db.db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(amount, user.id);
const updated = db.getUser(user.id);

console.log(`Updated "${updated.name}" (${updated.id}): credits = ${updated.credits}`);
