'use strict';

const { Client, GatewayIntentBits, PermissionsBitField, EmbedBuilder } = require('discord.js');
const store = require('../db/store');
const buyerQuota = require('../utils/buyerQuota');

let activeClient = null;

function parseList(raw) {
  if (Array.isArray(raw)) {
    return raw.map((s) => String(s || '').trim()).filter(Boolean);
  }
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const COLORS = {
  ok: 0x22c55e,
  info: 0x3b82f6,
  warn: 0xf59e0b,
  err: 0xef4444,
};

function makeEmbed(color, title, description) {
  const e = new EmbedBuilder().setColor(color).setTitle(title);
  if (description) e.setDescription(description);
  return e;
}

function replyEmbed(message, color, title, description, fields) {
  const embed = makeEmbed(color, title, description);
  if (Array.isArray(fields) && fields.length > 0) {
    embed.addFields(fields);
  }
  return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
}

function resolveRole(guild, token, roleScripts) {
  const raw = String(token || '').trim();
  if (!raw) return null;
  const idMatch = raw.match(/^<@&(\d{15,22})>$/) || raw.match(/^(\d{15,22})$/);
  if (idMatch) {
    return guild.roles.cache.get(idMatch[1]) || null;
  }
  const lower = raw.toLowerCase();
  const byName = guild.roles.cache.find((r) => r.id !== guild.id && r.name.toLowerCase() === lower);
  if (byName) return byName;

  const mapped = (roleScripts || []).find((r) => (r.label || '').toLowerCase() === lower);
  if (mapped) return guild.roles.cache.get(mapped.role_id) || null;

  return guild.roles.cache.find((r) => r.id !== guild.id && r.name.toLowerCase().includes(lower)) || null;
}

async function resolveMember(guild, token) {
  const raw = String(token || '').trim();
  const idMatch = raw.match(/^<@!?(\d{15,22})>$/) || raw.match(/^(\d{15,22})$/);
  if (!idMatch) return null;
  return guild.members.fetch(idMatch[1]).catch(() => null);
}

async function syncRoleScriptsToMemberUids(discordId, roleId, roleScripts) {
  const rule = (roleScripts || []).find((r) => r.role_id === roleId);
  const scripts = rule && Array.isArray(rule.scripts) ? rule.scripts : [];
  if (scripts.length === 0) return [];
  const granted = await buyerQuota.grantRoleScriptsToUids({ discordId, roleId });
  return granted > 0 ? scripts : [];
}

function hasAnyRole(member, roleIds) {
  return roleIds.some((id) => member.roles.cache.has(id));
}

function isDiscordAdmin(member, adminRoleIds) {
  if (!member) return false;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  return hasAnyRole(member, adminRoleIds);
}

async function getLiveBotConfig() {
  const data = await store.read();
  const cfg = (data.settings && data.settings.bot_config) || {};
  const prefix = (typeof cfg.prefix === 'string' && cfg.prefix.trim()) || (process.env.BOT_PREFIX || '!').trim() || '!';
  const buyerRoleIds =
    Array.isArray(cfg.buyer_role_ids) ? cfg.buyer_role_ids : parseList(process.env.BUYER_ROLE_IDS);
  const adminRoleIds =
    Array.isArray(cfg.admin_role_ids) ? cfg.admin_role_ids : parseList(process.env.ADMIN_ROLE_IDS);
  const defaultScripts =
    Array.isArray(cfg.default_scripts) ? cfg.default_scripts : parseList(process.env.DEFAULT_SCRIPTS);
  const roleScripts = Array.isArray(cfg.role_scripts) ? cfg.role_scripts : [];

  return { prefix, buyerRoleIds, adminRoleIds, defaultScripts, roleScripts };
}

function getBotStatus() {
  const tokenSet = Boolean((process.env.DISCORD_BOT_TOKEN || '').trim());
  const ready = Boolean(activeClient && activeClient.user);
  return {
    tokenSet,
    ready,
    tag: ready ? activeClient.user.tag : '',
  };
}

function getGuildRoles() {
  if (!activeClient || !activeClient.user) return [];
  const roles = [];
  for (const guild of activeClient.guilds.cache.values()) {
    const sorted = Array.from(guild.roles.cache.values())
      .filter((r) => r.id !== guild.id && !r.managed)
      .sort((a, b) => b.position - a.position);
    for (const r of sorted) {
      roles.push({
        id: r.id,
        name: r.name,
        guildName: guild.name,
      });
    }
  }
  return roles;
}

function startDiscordBot() {
  const token = (process.env.DISCORD_BOT_TOKEN || '').trim();
  if (!token) {
    console.log('[bot] DISCORD_BOT_TOKEN tidak diset — bot Discord dilewati.');
    return null;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once('ready', () => {
    console.log(`[bot] Discord bot aktif sebagai ${client.user.tag}`);
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    try {
      const { prefix, buyerRoleIds, adminRoleIds, defaultScripts, roleScripts } = await getLiveBotConfig();
      if (!message.content.startsWith(prefix)) return;

      const args = message.content.slice(prefix.length).trim().split(/\s+/);
      const cmd = (args.shift() || '').toLowerCase();
      if (!cmd) return;

      const member =
        message.member || (await message.guild.members.fetch(message.author.id).catch(() => null));
      if (!member) {
        return replyEmbed(message, COLORS.err, 'Gagal Memuat Member', 'Data role akunmu di server ini tidak terbaca.');
      }

      const isAdmin = isDiscordAdmin(member, adminRoleIds);
      const matchedRules = roleScripts.filter((r) => member.roles.cache.has(r.role_id));
      const hasGeneralBuyer = buyerRoleIds.length > 0 && hasAnyRole(member, buyerRoleIds);
      const openForAll = roleScripts.length === 0 && buyerRoleIds.length === 0;
      const hasBuyerAccess = matchedRules.length > 0 || hasGeneralBuyer || openForAll;

      if (cmd === 'help' || cmd === 'cmds') {
        if (!isAdmin) {
          return replyEmbed(message, COLORS.err, 'Akses Ditolak', 'Command ini khusus Admin.');
        }
        const fields = [
          {
            name: 'Buyer',
            value: [
              `\`${prefix}add <uid> [role]\` — Daftarkan UID Growtopia sesuai role`,
              `\`${prefix}myuid\` — Lihat daftar UID dan sisa kuota`,
            ].join('\n'),
          },
          {
            name: 'Admin',
            value: [
              `\`${prefix}addrole <@role|nama> <@buyer>\` — Beri role buyer & sinkronkan script`,
              `\`${prefix}delrole <@role|nama> <@buyer>\` — Cabut role buyer`,
              `\`${prefix}setmax <@buyer> <role> <jumlah>\` — Atur batas UID buyer per role`,
              `\`${prefix}del <uid>\` / \`${prefix}remove <uid>\` — Hapus UID dari whitelist`,
              `\`${prefix}myuid [@buyer]\` — Cek daftar UID milik buyer tertentu`,
            ].join('\n'),
          },
        ];
        return replyEmbed(message, COLORS.info, 'Daftar Command', null, fields);
      }

      if (cmd === 'add') {
        const uid = (args[0] || '').trim();
        if (!buyerQuota.UID_RE.test(uid)) {
          return replyEmbed(message, COLORS.warn, 'Format Salah', `Gunakan: \`${prefix}add 123456\` atau \`${prefix}add 123456 PNB\``);
        }

        const roleToken = args.slice(1).join(' ').trim();
        let selectedRules = [];
        let requestedScripts;
        let includeGeneral = false;

        if (roleToken) {
          const role = resolveRole(message.guild, roleToken, roleScripts);
          if (!role) {
            return replyEmbed(
              message,
              COLORS.warn,
              'Role Tidak Ditemukan',
              `Role \`${roleToken}\` tidak ditemukan di server ini.`
            );
          }
          const rule = roleScripts.find((r) => r.role_id === role.id);
          if (!rule) {
            return replyEmbed(
              message,
              COLORS.warn,
              'Role Belum Di-mapping',
              `Role ${role.name} belum punya script di panel Bot.`
            );
          }
          if (!member.roles.cache.has(role.id) && !isAdmin) {
            return replyEmbed(message, COLORS.err, 'Akses Ditolak', `Role ${role.name} bukan role buyer kamu.`);
          }
          selectedRules = [rule];
          requestedScripts = Array.isArray(rule.scripts) ? [...rule.scripts] : [];
        } else if (matchedRules.length > 1) {
          const choices = matchedRules.map((r) => r.label || r.role_id).join(', ');
          return replyEmbed(
            message,
            COLORS.warn,
            'Pilih Role',
            `Kamu punya beberapa role buyer (${choices}). Gunakan \`${prefix}add ${uid} <role>\` supaya kuota per role sesuai.`
          );
        } else if (matchedRules.length === 1) {
          selectedRules = matchedRules;
          requestedScripts = Array.from(
            new Set(matchedRules.flatMap((r) => (Array.isArray(r.scripts) ? r.scripts : [])))
          );
        } else if (roleScripts.length > 0) {
          if (!hasGeneralBuyer) {
            return replyEmbed(
              message,
              COLORS.err,
              'Akses Ditolak',
              'Akunmu belum memiliki role buyer yang terhubung ke script apa pun.'
            );
          }
        } else if (!hasGeneralBuyer && !openForAll && !isAdmin) {
          return replyEmbed(
            message,
            COLORS.err,
            'Akses Ditolak',
            'Akunmu belum memiliki role buyer. Hubungi admin setelah pembayaran.'
          );
        }

        if (hasGeneralBuyer && defaultScripts.length > 0) {
          requestedScripts = Array.from(new Set([...(requestedScripts || []), ...defaultScripts]));
          includeGeneral = true;
        }
        if (!requestedScripts || requestedScripts.length === 0) {
          requestedScripts = defaultScripts.length > 0 ? defaultScripts : undefined;
        }

        const { body } = await buyerQuota.addBuyerUid({
          uid,
          discordId: message.author.id,
          discordName: message.author.username,
          requestedScripts,
          requestedRoleIds: selectedRules.map((r) => r.role_id),
          includeGeneral,
        });

        if (!body.ok) {
          return replyEmbed(message, COLORS.err, 'Gagal Mendaftarkan UID', body.message || body.error);
        }

        const quotaValue = Array.isArray(body.quotas) && body.quotas.length > 0
          ? body.quotas.map((q) => `${q.label}: **${q.used}/${q.max}**`).join('\n')
          : `**${body.used}/${body.max}**`;
        const shownRules = selectedRules.length > 0 ? selectedRules : matchedRules;
        const matchedLabels = shownRules.map((r) => r.label || r.role_id).filter(Boolean);
        const fields = [
          { name: 'UID', value: `\`${body.uid}\``, inline: true },
          { name: 'Kuota', value: quotaValue, inline: false },
          { name: 'Script Aktif', value: `\`${(body.scripts || []).join(', ') || '-'}\``, inline: false },
        ];
        if (matchedLabels.length > 0) {
          fields.push({ name: 'Role', value: matchedLabels.join(', '), inline: false });
        }
        return replyEmbed(message, COLORS.ok, 'UID Terdaftar', null, fields);
      }

      if (cmd === 'myuid') {
        if (!isAdmin && !hasBuyerAccess) {
          return replyEmbed(message, COLORS.err, 'Akses Ditolak', 'Command ini khusus member yang memiliki role buyer.');
        }

        let targetId = message.author.id;
        let targetLabel = message.author.username;
        if (args[0]) {
          if (!isAdmin) {
            return replyEmbed(message, COLORS.err, 'Akses Ditolak', 'Hanya Admin yang bisa mengecek UID milik orang lain.');
          }
          const targetMember = await resolveMember(message.guild, args[0]);
          if (!targetMember) {
            return replyEmbed(message, COLORS.warn, 'Member Tidak Ditemukan', `Gunakan: \`${prefix}myuid @buyer\``);
          }
          targetId = targetMember.id;
          targetLabel = targetMember.user.username;
        }

        const { body } = await buyerQuota.getBuyerInfo(targetId);
        if (!body.ok) {
          return replyEmbed(message, COLORS.err, 'Gagal', 'Data UID gagal diambil dari server.');
        }
        const quotaLines = (body.quotas || [])
          .map((q) => `• ${q.label}: **${q.used}/${q.max}**`)
          .join('\n');
        const quotaValue = quotaLines || `**${body.used}/${body.max}**`;
        if (!body.uids || body.uids.length === 0) {
          return replyEmbed(
            message,
            COLORS.info,
            `UID — ${targetLabel}`,
            `Belum ada UID terdaftar.\n${quotaValue}\nGunakan \`${prefix}add <uid>\`.`
          );
        }
        const list = body.uids
          .map((u) => `• \`${u.uid}\` — ${u.status}${Array.isArray(u.scripts) && u.scripts.length ? ` (\`${u.scripts.join(', ')}\`)` : ''}`)
          .join('\n');
        return replyEmbed(message, COLORS.info, `UID — ${targetLabel}`, null, [
          { name: 'UID', value: list, inline: false },
          { name: 'Kuota per Role', value: quotaValue, inline: false },
        ]);
      }

      if (cmd === 'deluid' || cmd === 'del' || cmd === 'remove' || cmd === 'removeuid') {
        if (!isAdmin) {
          return replyEmbed(message, COLORS.err, 'Akses Ditolak', 'Command ini khusus Admin.');
        }
        const uid = (args[0] || '').trim();
        if (!buyerQuota.UID_RE.test(uid)) {
          return replyEmbed(message, COLORS.warn, 'Format Salah', `Gunakan: \`${prefix}${cmd} 123456\``);
        }
        const { body } = await buyerQuota.removeBuyerUid({
          uid,
          discordId: message.author.id,
          force: true,
        });
        if (!body.ok) {
          return replyEmbed(message, COLORS.err, 'Gagal Menghapus UID', body.message || body.error);
        }
        return replyEmbed(message, COLORS.ok, 'UID Dihapus', `UID \`${body.removed}\` telah dihapus dari whitelist.`);
      }

      if (cmd === 'addrole' || cmd === 'delrole') {
        if (!isAdmin) {
          return replyEmbed(message, COLORS.err, 'Akses Ditolak', 'Command ini khusus Admin.');
        }
        if (args.length < 2) {
          return replyEmbed(
            message,
            COLORS.warn,
            'Format Salah',
            `Gunakan: \`${prefix}${cmd} <@role|nama_role> <@buyer>\``
          );
        }

        const targetToken = args[args.length - 1];
        const roleToken = args.slice(0, -1).join(' ');
        const targetMember = await resolveMember(message.guild, targetToken);
        if (!targetMember) {
          return replyEmbed(
            message,
            COLORS.warn,
            'Buyer Tidak Ditemukan',
            `Pastikan mention atau User ID buyer valid.\nContoh: \`${prefix}${cmd} @SB @buyer\``
          );
        }

        const role = resolveRole(message.guild, roleToken, roleScripts);
        if (!role) {
          return replyEmbed(
            message,
            COLORS.warn,
            'Role Tidak Ditemukan',
            `Role \`${roleToken}\` tidak ditemukan di server ini.`
          );
        }

        const me = message.guild.members.me;
        if (!me || !me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
          return replyEmbed(message, COLORS.err, 'Izin Bot Kurang', 'Bot membutuhkan permission **Manage Roles** di server.');
        }
        if (role.position >= me.roles.highest.position) {
          return replyEmbed(
            message,
            COLORS.err,
            'Posisi Role Terlalu Tinggi',
            `Pindahkan role bot di atas **${role.name}** pada Server Settings → Roles.`
          );
        }

        if (cmd === 'addrole') {
          await targetMember.roles.add(role, `Diberikan oleh ${message.author.tag} via ${prefix}addrole`);
          const synced = await syncRoleScriptsToMemberUids(targetMember.id, role.id, roleScripts);
          const fields = [
            { name: 'Buyer', value: `<@${targetMember.id}>`, inline: true },
            { name: 'Role', value: `<@&${role.id}>`, inline: true },
          ];
          if (synced.length > 0) {
            fields.push({ name: 'Script Tersinkron', value: `\`${synced.join(', ')}\``, inline: false });
          }
          return replyEmbed(message, COLORS.ok, 'Role Ditambahkan', null, fields);
        }

        await targetMember.roles.remove(role, `Dicabut oleh ${message.author.tag} via ${prefix}delrole`);
        return replyEmbed(message, COLORS.ok, 'Role Dicabut', null, [
          { name: 'Buyer', value: `<@${targetMember.id}>`, inline: true },
          { name: 'Role', value: `<@&${role.id}>`, inline: true },
        ]);
      }

      if (cmd === 'setmax') {
        if (!isAdmin) {
          return replyEmbed(message, COLORS.err, 'Akses Ditolak', 'Command ini khusus Admin.');
        }
        const buyerToken = args[0] || '';
        const rawMax = args[args.length - 1];
        const roleToken = args.slice(1, -1).join(' ').trim();
        const targetMember = await resolveMember(message.guild, buyerToken);
        const rawId = targetMember ? targetMember.id : buyerToken.replace(/[<@!>]/g, '');

        let roleId = '';
        let roleLabel = 'Umum';
        if (roleToken) {
          const role = resolveRole(message.guild, roleToken, roleScripts);
          if (!role) {
            return replyEmbed(
              message,
              COLORS.warn,
              'Role Tidak Ditemukan',
              `Role \`${roleToken}\` tidak ditemukan di server ini.`
            );
          }
          const rule = roleScripts.find((r) => r.role_id === role.id);
          if (!rule) {
            return replyEmbed(
              message,
              COLORS.warn,
              'Role Belum Di-mapping',
              `Role ${role.name} belum punya script di panel Bot.`
            );
          }
          roleId = role.id;
          roleLabel = rule.label || role.name;
        } else if (roleScripts.length > 0) {
          const choices = roleScripts
            .map((r) => `${prefix}setmax @buyer ${r.label || r.role_id} 2`)
            .join('\n');
          return replyEmbed(
            message,
            COLORS.warn,
            'Format Salah',
            `Role wajib dicantumkan:\n${choices}`
          );
        }

        const { body } = await buyerQuota.setBuyerMax({
          discordId: rawId,
          roleId,
          maxUids: Number(rawMax),
          note: targetMember ? targetMember.user.username : '',
        });
        if (!body.ok) {
          return replyEmbed(
            message,
            COLORS.warn,
            'Format Salah',
            `Gunakan: \`${prefix}setmax @buyer ${roleLabel} 2\` (${body.message || body.error})`
          );
        }
        return replyEmbed(message, COLORS.ok, 'Kuota Diperbarui', null, [
          { name: 'Buyer', value: `<@${rawId}>`, inline: true },
          { name: 'Role', value: roleId ? `<@&${roleId}>` : 'Umum', inline: true },
          { name: 'Maksimal UID', value: `**${body.max_uids}**`, inline: true },
        ]);
      }
    } catch (err) {
      console.error('[bot] error memproses command:', err);
      return replyEmbed(message, COLORS.err, 'Terjadi Kesalahan', 'Gagal memproses command. Cek log server.');
    }
  });

  client.login(token).catch((err) => {
    console.error('[bot] Gagal login Discord bot:', err && err.message ? err.message : err);
  });

  activeClient = client;
  return client;
}

async function stopDiscordBot() {
  if (!activeClient) return;
  const c = activeClient;
  activeClient = null;
  try {
    await c.destroy();
  } catch {
    /* ignore */
  }
}

module.exports = { startDiscordBot, stopDiscordBot, getBotStatus, getGuildRoles };
