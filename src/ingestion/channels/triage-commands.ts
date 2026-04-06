/**
 * Triage management commands — called from TelegramBot.handleCommand()
 *
 * Commands:
 *   /triage                    — show current config
 *   /triage on|off             — enable/disable
 *   /triage mention-only on|off — only process @mentions (default: off)
 *   /triage ignore-own on|off  — ignore own team unless @mentioned (default: on)
 *
 *   /teams                     — list all teams
 *   /add_team <name> [desc]    — create a team
 *   /team <name>               — show team details
 *   /remove_team <name>        — delete a team
 *   /team_own <name> on|off    — mark team as internal (own team)
 *
 *   /add_handle <team> <@handle>  — add a handle to a team
 *   /remove_handle <team> <@handle>
 *   /add_keyword <team> <kw>      — add a keyword to a team
 *   /remove_keyword <team> <kw>
 *
 *   /my_handles                — show my personal handles
 *   /add_my_handle <handle>    — add a handle that means "me"
 *   /remove_my_handle <handle>
 *
 *   /whitelist                 — list whitelist keywords
 *   /add_whitelist <keyword>   — add whitelist keyword
 *   /remove_whitelist <keyword>
 */

import { getConfig, patchConfig } from '../../config/index.js';

type SendFn = (text: string) => Promise<void>;

// ─── /triage ──────────────────────────────────────────────────────────────────

export async function cmdTriage(args: string[], send: SendFn): Promise<void> {
  const cfg = getConfig().triage;

  if (args.length === 0) {
    // Show summary
    const lines = [
      `⚙️ *Triage config*\n`,
      `Enabled:       ${cfg.enabled ? '✅ on' : '❌ off'}`,
      `Mention-only:  ${cfg.mentionOnly ? '✅ on' : '❌ off'} _(triage only if @mentioned)_`,
      `Ignore-own:    ${cfg.ignoreOwnTeam ? '✅ on' : '❌ off'} _(skip own team unless @mentioned)_`,
      ``,
      `My handles:    ${cfg.myHandles.length ? cfg.myHandles.join(', ') : '_none_'}`,
      `Teams:         ${cfg.watchedTeams.length ? cfg.watchedTeams.map((t) => `${t.name}${t.isOwnTeam ? ' (own)' : ''}`).join(', ') : '_none_'}`,
      `Whitelist kw:  ${cfg.whitelistKeywords.length} keyword(s)`,
      ``,
      `_/triage on|off · /triage mention-only on|off · /triage ignore-own on|off_`,
    ];
    await send(lines.join('\n'));
    return;
  }

  const [sub, val] = args;

  if (sub === 'on' || sub === 'off') {
    patchConfig((c) => {
      c.triage.enabled = sub === 'on';
    });
    await send(`✅ Triage ${sub === 'on' ? 'activé' : 'désactivé'}`);
    return;
  }

  if (sub === 'mention-only') {
    if (!val || (val !== 'on' && val !== 'off')) {
      await send('❌ Usage: /triage mention-only on|off');
      return;
    }
    patchConfig((c) => {
      c.triage.mentionOnly = val === 'on';
    });
    await send(
      `✅ Mention-only: ${val === 'on' ? 'on — triage uniquement si @mention' : 'off — tous les messages partenaires'}`,
    );
    return;
  }

  if (sub === 'ignore-own') {
    if (!val || (val !== 'on' && val !== 'off')) {
      await send('❌ Usage: /triage ignore-own on|off');
      return;
    }
    patchConfig((c) => {
      c.triage.ignoreOwnTeam = val === 'on';
    });
    await send(
      `✅ Ignore-own: ${val === 'on' ? 'on — équipe interne ignorée sauf @mention' : 'off — équipe interne toujours triée'}`,
    );
    return;
  }

  await send(
    '❌ Usage: /triage | /triage on|off | /triage mention-only on|off | /triage ignore-own on|off',
  );
}

// ─── /teams ───────────────────────────────────────────────────────────────────

export async function cmdTeams(send: SendFn): Promise<void> {
  const teams = getConfig().triage.watchedTeams;
  if (teams.length === 0) {
    await send('📭 Aucune équipe configurée.\n\n_/add_team <nom> [description]_');
    return;
  }
  const lines = [`👥 *Équipes configurées (${teams.length})*\n`];
  for (const t of teams) {
    const badge = t.isOwnTeam ? ' _(équipe interne)_' : ' _(partenaire)_';
    lines.push(`*${t.name}*${badge}`);
    if (t.description) lines.push(`  _${t.description}_`);
    lines.push(`  Handles:  ${t.handles.length ? t.handles.join(', ') : '_aucun_'}`);
    lines.push(`  Keywords: ${t.keywords.length ? t.keywords.join(', ') : '_aucun_'}`);
    lines.push('');
  }
  lines.push(`_/team <nom>  ·  /add_team  ·  /remove_team <nom>_`);
  await send(lines.join('\n'));
}

// ─── /add_team ────────────────────────────────────────────────────────────────

export async function cmdAddTeam(args: string[], send: SendFn): Promise<void> {
  if (args.length === 0) {
    await send('❌ Usage: /add_team <nom> [description]');
    return;
  }
  const [name, ...rest] = args;
  const description = rest.join(' ') || undefined;

  const existing = getConfig().triage.watchedTeams.find(
    (t) => t.name.toLowerCase() === name.toLowerCase(),
  );
  if (existing) {
    await send(`⚠️ L'équipe *${name}* existe déjà.\n_/team ${name} pour voir ses détails_`);
    return;
  }

  patchConfig((c) => {
    c.triage.watchedTeams.push({ name, handles: [], keywords: [], description, isOwnTeam: false });
  });
  await send(
    `✅ Équipe *${name}* créée${description ? ` — _${description}_` : ''}\n\n_/add_handle ${name} @pseudo  pour ajouter des membres_\n_/team_own ${name} on  si c'est ton équipe interne_`,
  );
}

// ─── /team <name> ─────────────────────────────────────────────────────────────

export async function cmdTeam(args: string[], send: SendFn): Promise<void> {
  if (args.length === 0) {
    await send('❌ Usage: /team <nom>');
    return;
  }
  const name = args[0];
  const t = getConfig().triage.watchedTeams.find(
    (t) => t.name.toLowerCase() === name.toLowerCase(),
  );
  if (!t) {
    await send(`❌ Équipe *${name}* introuvable. /teams pour voir la liste.`);
    return;
  }

  const lines = [
    `👥 *${t.name}*${t.isOwnTeam ? ' _(équipe interne)_' : ' _(partenaire)_'}`,
    t.description ? `_${t.description}_` : '',
    '',
    `Handles:  ${t.handles.length ? t.handles.join(', ') : '_aucun_'}`,
    `Keywords: ${t.keywords.length ? t.keywords.join(', ') : '_aucun_'}`,
    '',
    `_/add_handle ${t.name} @pseudo_`,
    `_/add_keyword ${t.name} <mot>_`,
    `_/team_own ${t.name} on|off_`,
    `_/remove_team ${t.name}_`,
  ];
  await send(lines.filter((l) => l !== '').join('\n'));
}

// ─── /remove_team ─────────────────────────────────────────────────────────────

export async function cmdRemoveTeam(args: string[], send: SendFn): Promise<void> {
  if (args.length === 0) {
    await send('❌ Usage: /remove_team <nom>');
    return;
  }
  const name = args[0];
  const before = getConfig().triage.watchedTeams.length;
  patchConfig((c) => {
    c.triage.watchedTeams = c.triage.watchedTeams.filter(
      (t) => t.name.toLowerCase() !== name.toLowerCase(),
    );
  });
  if (getConfig().triage.watchedTeams.length < before) {
    await send(`✅ Équipe *${name}* supprimée`);
  } else {
    await send(`❌ Équipe *${name}* introuvable`);
  }
}

// ─── /team_own ────────────────────────────────────────────────────────────────

export async function cmdTeamOwn(args: string[], send: SendFn): Promise<void> {
  if (args.length < 2) {
    await send('❌ Usage: /team_own <nom> on|off');
    return;
  }
  const [name, val] = args;
  if (val !== 'on' && val !== 'off') {
    await send('❌ Usage: /team_own <nom> on|off');
    return;
  }
  const found = getConfig().triage.watchedTeams.find(
    (t) => t.name.toLowerCase() === name.toLowerCase(),
  );
  if (!found) {
    await send(`❌ Équipe *${name}* introuvable`);
    return;
  }
  patchConfig((c) => {
    const t = c.triage.watchedTeams.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (t) t.isOwnTeam = val === 'on';
  });
  await send(
    `✅ *${found.name}* marqué comme ${val === 'on' ? 'équipe interne (messages ignorés sauf @mention)' : 'équipe externe (partenaire)'}`,
  );
}

// ─── /add_handle / /remove_handle ────────────────────────────────────────────

export async function cmdAddHandle(args: string[], send: SendFn): Promise<void> {
  if (args.length < 2) {
    await send('❌ Usage: /add_handle <équipe> <handle>');
    return;
  }
  const [name, handle] = args;
  const norm = handle.startsWith('@') ? handle : `@${handle}`; // always store with @
  const found = getConfig().triage.watchedTeams.find(
    (t) => t.name.toLowerCase() === name.toLowerCase(),
  );
  if (!found) {
    await send(`❌ Équipe *${name}* introuvable. /add_team ${name} pour la créer.`);
    return;
  }
  if (found.handles.some((h) => h.replace(/^@/, '') === norm.replace(/^@/, ''))) {
    await send(`⚠️ \`${norm}\` déjà dans l'équipe *${found.name}*`);
    return;
  }
  patchConfig((c) => {
    const t = c.triage.watchedTeams.find((t) => t.name.toLowerCase() === name.toLowerCase());
    t?.handles.push(norm);
  });
  await send(`✅ \`${norm}\` ajouté à l'équipe *${found.name}*`);
}

export async function cmdRemoveHandle(args: string[], send: SendFn): Promise<void> {
  if (args.length < 2) {
    await send('❌ Usage: /remove_handle <équipe> <handle>');
    return;
  }
  const [name, handle] = args;
  const norm = handle.replace(/^@/, ''); // strip @ for comparison
  const found = getConfig().triage.watchedTeams.find(
    (t) => t.name.toLowerCase() === name.toLowerCase(),
  );
  if (!found) {
    await send(`❌ Équipe *${name}* introuvable`);
    return;
  }
  const before = found.handles.length;
  patchConfig((c) => {
    const t = c.triage.watchedTeams.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (t) t.handles = t.handles.filter((h) => h.replace(/^@/, '') !== norm);
  });
  const after =
    getConfig().triage.watchedTeams.find((t) => t.name.toLowerCase() === name.toLowerCase())
      ?.handles.length ?? 0;
  if (after === before) {
    await send(`⚠️ Handle \`${handle}\` non trouvé dans l'équipe *${found.name}*`);
  } else {
    await send(`✅ \`${handle}\` retiré de l'équipe *${found.name}*`);
  }
}

// ─── /add_keyword / /remove_keyword ──────────────────────────────────────────

export async function cmdAddKeyword(args: string[], send: SendFn): Promise<void> {
  if (args.length < 2) {
    await send('❌ Usage: /add_keyword <équipe> <mot-clé>');
    return;
  }
  const [name, ...kwParts] = args;
  const kw = kwParts.join(' ');
  const found = getConfig().triage.watchedTeams.find(
    (t) => t.name.toLowerCase() === name.toLowerCase(),
  );
  if (!found) {
    await send(`❌ Équipe *${name}* introuvable`);
    return;
  }
  if (found.keywords.map((k) => k.toLowerCase()).includes(kw.toLowerCase())) {
    await send(`⚠️ Keyword \`${kw}\` déjà dans l'équipe *${found.name}*`);
    return;
  }
  patchConfig((c) => {
    const t = c.triage.watchedTeams.find((t) => t.name.toLowerCase() === name.toLowerCase());
    t?.keywords.push(kw);
  });
  await send(`✅ Keyword \`${kw}\` ajouté à l'équipe *${found.name}*`);
}

export async function cmdRemoveKeyword(args: string[], send: SendFn): Promise<void> {
  if (args.length < 2) {
    await send('❌ Usage: /remove_keyword <équipe> <mot-clé>');
    return;
  }
  const [name, ...kwParts] = args;
  const kw = kwParts.join(' ').toLowerCase();
  const found = getConfig().triage.watchedTeams.find(
    (t) => t.name.toLowerCase() === name.toLowerCase(),
  );
  if (!found) {
    await send(`❌ Équipe *${name}* introuvable`);
    return;
  }
  patchConfig((c) => {
    const t = c.triage.watchedTeams.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (t) t.keywords = t.keywords.filter((k) => k.toLowerCase() !== kw);
  });
  await send(`✅ Keyword \`${kw}\` retiré de *${found.name}*`);
}

// ─── /my_handles ─────────────────────────────────────────────────────────────

export async function cmdMyHandles(send: SendFn): Promise<void> {
  const handles = getConfig().triage.myHandles;
  if (handles.length === 0) {
    await send('📭 Aucun handle personnel configuré.\n\n_/add_my_handle @monpseudo_');
    return;
  }
  await send(
    `👤 *Mes handles* (déclenchent my_task quand mentionnés)\n\n${handles.join('\n')}\n\n_/add_my_handle @pseudo · /remove_my_handle @pseudo_`,
  );
}

export async function cmdAddMyHandle(args: string[], send: SendFn): Promise<void> {
  if (args.length === 0) {
    await send('❌ Usage: /add_my_handle <@handle ou prénom>');
    return;
  }
  const handle = args[0];
  const handles = getConfig().triage.myHandles;
  if (handles.includes(handle)) {
    await send(`⚠️ \`${handle}\` déjà dans tes handles`);
    return;
  }
  patchConfig((c) => {
    c.triage.myHandles.push(handle);
  });
  await send(`✅ \`${handle}\` ajouté à tes handles personnels`);
}

export async function cmdRemoveMyHandle(args: string[], send: SendFn): Promise<void> {
  if (args.length === 0) {
    await send('❌ Usage: /remove_my_handle <@handle>');
    return;
  }
  const handle = args[0];
  patchConfig((c) => {
    c.triage.myHandles = c.triage.myHandles.filter((h) => h !== handle);
  });
  await send(`✅ \`${handle}\` retiré de tes handles`);
}

// ─── /whitelist ───────────────────────────────────────────────────────────────

export async function cmdWhitelist(send: SendFn): Promise<void> {
  const kws = getConfig().triage.whitelistKeywords;
  const lines = [
    `🔐 *Whitelist keywords* (${kws.length})\n`,
    ...kws.map((k, i) => `${i + 1}. \`${k}\``),
    '',
    `_Ces mots déclenchent une demande de tx review pack._`,
    `_/add_whitelist <mot> · /remove_whitelist <mot>_`,
  ];
  await send(lines.join('\n'));
}

export async function cmdAddWhitelist(args: string[], send: SendFn): Promise<void> {
  if (args.length === 0) {
    await send('❌ Usage: /add_whitelist <keyword>');
    return;
  }
  const kw = args.join(' ');
  const existing = getConfig().triage.whitelistKeywords;
  if (existing.map((k) => k.toLowerCase()).includes(kw.toLowerCase())) {
    await send(`⚠️ \`${kw}\` déjà dans la whitelist`);
    return;
  }
  patchConfig((c) => {
    c.triage.whitelistKeywords.push(kw);
  });
  await send(`✅ \`${kw}\` ajouté aux whitelist keywords`);
}

export async function cmdRemoveWhitelist(args: string[], send: SendFn): Promise<void> {
  if (args.length === 0) {
    await send('❌ Usage: /remove_whitelist <keyword>');
    return;
  }
  const kw = args.join(' ').toLowerCase();
  patchConfig((c) => {
    c.triage.whitelistKeywords = c.triage.whitelistKeywords.filter((k) => k.toLowerCase() !== kw);
  });
  await send(`✅ Whitelist keyword \`${kw}\` retiré`);
}
