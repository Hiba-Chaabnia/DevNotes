/**
 * Simulation of StatusBarController logic.
 * Run with: node scripts/simulate-statusbar.mjs
 *
 * Prints what each status bar item would show given a set of mock notes,
 * then walks through three scenarios: overdue reminders, linked notes,
 * and a combined state.
 */

const now = Date.now();
const hour = 60 * 60 * 1000;
const day  = 24 * hour;

// ─── Mock notes ──────────────────────────────────────────────────────────────

const notes = [
  {
    id: 'note1', title: 'Fix auth token expiry', archived: false,
    remindAt: now - 2 * hour,          // overdue by 2h
    codeLink: { file: 'src/auth.ts', line: 42 },
  },
  {
    id: 'note2', title: 'Refactor login flow', archived: false,
    remindAt: now - day,               // overdue by 1 day
    codeLink: null,
  },
  {
    id: 'note3', title: 'Update docs', archived: false,
    remindAt: now + day,               // future — not overdue
    codeLink: null,
  },
  {
    id: 'note4', title: 'Old archived bug', archived: true,
    remindAt: now - hour,              // overdue but archived — must be ignored
    codeLink: { file: 'src/auth.ts', line: 10 },
  },
  {
    id: 'note5', title: 'Auth middleware note', archived: false,
    remindAt: null,
    codeLink: { file: 'src/auth.ts', line: 88 },
  },
  {
    id: 'note6', title: 'API rate limiting', archived: false,
    remindAt: null,
    codeLink: { file: 'src/api.ts', line: 15 },
  },
];

// ─── StatusBarController logic (mirrored from StatusBarController.ts) ────────

function getReminderItem(notes) {
  const overdue = notes.filter(n => !n.archived && n.remindAt && n.remindAt <= now);
  if (overdue.length === 0) return null;
  const count = overdue.length;
  return {
    text   : `$(bell) ${count} overdue`,
    tooltip: count === 1
      ? `1 overdue reminder: "${overdue[0].title}" — click to open DevNotes`
      : `${count} overdue reminders — click to open DevNotes`,
    background: 'statusBarItem.warningBackground',
    titles: overdue.map(n => n.title),
  };
}

function getLinkedItem(notes, activeFile) {
  if (!activeFile) return null;
  const linked = notes.filter(n => !n.archived && n.codeLink?.file === activeFile);
  if (linked.length === 0) return null;
  const count = linked.length;
  return {
    text   : `$(notebook) ${count} note${count !== 1 ? 's' : ''} here`,
    tooltip: linked.map(n => `• ${n.title}`).join('\n') + '\n\nClick to open DevNotes',
    titles : linked.map(n => n.title),
  };
}

// ─── Display helper ───────────────────────────────────────────────────────────

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const GREY   = '\x1b[90m';

function printStatusBar(reminderItem, linkedItem) {
  const parts = [];
  if (reminderItem) parts.push(`${YELLOW}${BOLD} ${reminderItem.text} ${RESET}`);
  if (linkedItem)   parts.push(`${CYAN}${BOLD} ${linkedItem.text} ${RESET}`);
  if (parts.length === 0) {
    console.log(`  Status bar: ${GREY}(nothing shown)${RESET}`);
  } else {
    console.log(`  Status bar: [ ${parts.join('  ')} ]`);
  }
}

function printTooltip(label, item) {
  if (!item) return;
  console.log(`\n  ${DIM}${label} tooltip:${RESET}`);
  item.tooltip.split('\n').forEach(l => console.log(`    ${GREY}${l}${RESET}`));
}

function printScenario(title, notes, activeFile) {
  console.log(`\n${BOLD}${GREEN}── ${title}${RESET}`);
  if (activeFile) console.log(`  Active file: ${CYAN}${activeFile}${RESET}`);
  else            console.log(`  Active file: ${GREY}(none)${RESET}`);

  const r = getReminderItem(notes);
  const l = getLinkedItem(notes, activeFile);
  printStatusBar(r, l);
  printTooltip('Reminder item', r);
  printTooltip('Linked item', l);
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

console.log(`\n${BOLD}DevNotes — Status Bar Simulation${RESET}`);
console.log(`${DIM}Using ${notes.length} mock notes, current time: ${new Date(now).toLocaleTimeString()}${RESET}`);

console.log(`\n${BOLD}Mock notes:${RESET}`);
notes.forEach(n => {
  const status   = n.archived   ? `${GREY}[archived]${RESET}` : `${GREEN}[active]${RESET}  `;
  const reminder = n.remindAt
    ? (n.remindAt <= now ? `${RED}overdue${RESET}` : `${GREEN}future${RESET} `)
    : `${GREY}none${RESET}   `;
  const link = n.codeLink ? `${CYAN}${n.codeLink.file}:${n.codeLink.line}${RESET}` : `${GREY}no link${RESET}`;
  console.log(`  ${status} "${n.title}" | reminder: ${reminder} | link: ${link}`);
});

// Scenario 1: No active file
printScenario('No active editor', notes, null);

// Scenario 2: Active file with linked notes (auth.ts has 2 active + 1 archived)
printScenario('Active file: src/auth.ts', notes, 'src/auth.ts');

// Scenario 3: Active file with no linked notes
printScenario('Active file: src/utils.ts (no notes)', notes, 'src/utils.ts');

// Scenario 4: All reminders cleared (future only)
const noOverdue = notes.map(n => ({ ...n, remindAt: n.remindAt ? now + day : null }));
printScenario('All reminders cleared / future', noOverdue, 'src/auth.ts');

// Scenario 5: Everything archived
const allArchived = notes.map(n => ({ ...n, archived: true }));
printScenario('All notes archived', allArchived, 'src/auth.ts');

console.log('\n');
