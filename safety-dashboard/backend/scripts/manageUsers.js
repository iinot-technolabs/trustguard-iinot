#!/usr/bin/env node
'use strict';
// Dashboard user management (TG-010). Run from the backend folder:
//   node scripts/manageUsers.js add <username> <role>     roles: admin | supervisor | auditor | claims-reviewer
//   node scripts/manageUsers.js passwd <username>
//   node scripts/manageUsers.js disable <username>
//   node scripts/manageUsers.js enable <username>
//   node scripts/manageUsers.js list
// Passwords are typed at a hidden prompt, never passed on the command line.
const readline = require('readline');
const path     = require('path');
process.chdir(path.join(__dirname, '..'));
require('dotenv').config();
const auth = require('../lib/auth');

function askHidden(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

async function newPassword(username) {
  const p1 = await askHidden(`New password for ${username}: `);
  if (p1.length < 10) throw new Error('Password must be at least 10 characters');
  const p2 = await askHidden('Repeat password: ');
  if (p1 !== p2) throw new Error('Passwords do not match');
  return p1;
}

(async () => {
  const [cmd, username, role] = process.argv.slice(2);
  const users = auth.loadUsers();
  const find  = () => users.find(u => u.username === username);

  switch (cmd) {
    case 'add': {
      if (!username || !/^[a-z0-9._-]{3,32}$/i.test(username)) throw new Error('Username: 3-32 chars, letters/digits/._-');
      if (!auth.ROLES.includes(role)) throw new Error(`Role must be one of: ${auth.ROLES.join(', ')}`);
      if (find()) throw new Error(`User '${username}' already exists (use passwd to reset)`);
      const { salt, hash } = auth.hashPassword(await newPassword(username));
      users.push({ username, role, salt, hash, disabled: false, createdAt: new Date().toISOString() });
      auth.saveUsers(users);
      const id = auth.ROLE_IDENTITIES[role].identity;
      console.log(`Added '${username}' as ${role}${id ? ` (signs chaincode calls as ${id})` : ''}`);
      break;
    }
    case 'passwd': {
      const u = find(); if (!u) throw new Error(`No user '${username}'`);
      Object.assign(u, auth.hashPassword(await newPassword(username)));
      auth.saveUsers(users); console.log(`Password changed for '${username}'`);
      break;
    }
    case 'disable': case 'enable': {
      const u = find(); if (!u) throw new Error(`No user '${username}'`);
      u.disabled = cmd === 'disable';
      auth.saveUsers(users); console.log(`'${username}' ${cmd}d (takes effect on its next request)`);
      break;
    }
    case 'list':
      if (!users.length) console.log('(no users yet)');
      for (const u of users) console.log(`${u.username.padEnd(20)} ${u.role.padEnd(16)} ${u.disabled ? 'DISABLED' : 'active'}`);
      break;
    default:
      console.log('Usage: node scripts/manageUsers.js add <user> <role> | passwd <user> | disable <user> | enable <user> | list');
      process.exit(1);
  }
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
