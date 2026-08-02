require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
} = require("discord.js");

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;
const PORT = Number(process.env.PORT || 3000);

if (!TOKEN || !CLIENT_ID) {
  console.error("Missing TOKEN or CLIENT_ID in .env");
  process.exit(1);
}

const BOT_NAME = "G1yrex Support";
const DATA_DIR = fs.existsSync("/data") ? "/data" : __dirname;
const CONFIG_PATH = path.join(DATA_DIR, "ticket-config.json");

const defaultConfig = {
  guilds: {},
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return structuredClone(defaultConfig);
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.guilds || typeof parsed.guilds !== "object") return structuredClone(defaultConfig);
    return parsed;
  } catch {
    return structuredClone(defaultConfig);
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function ensureGuildConfig(guildId) {
  if (!config.guilds[guildId]) {
    config.guilds[guildId] = {
      ticketTypes: {
        support: { categoryId: null, permIds: [] },
        staffapp: { categoryId: null, permIds: [] },
        mediaapp: { categoryId: null, permIds: [] },
      },
      logsChannelId: null,
      staffEntries: [],
      activity: {},
      levels: {},
      economy: {},
      warnings: {},
      tags: {},
      giveaways: {},
      events: {},
      afk: {},
      countingChannelId: null,
      countingNext: 1,
      autoRoleId: null,
      welcomeChannelId: null,
      restrictedWords: [],
      violations: { link: {}, word: {} },
      staff: {
        notes: {},
        warnings: {},
        applicationsOpen: true,
        applications: [],
        pay: {},
        modeOn: {},
        chatChannelId: null,
        logsChannelId: null,
      },
      nextEventId: 1,
    };
  }

  const g = config.guilds[guildId];
  if (!Array.isArray(g.staffEntries)) g.staffEntries = [];
  if (!g.activity || typeof g.activity !== "object") g.activity = {};
  if (!g.levels || typeof g.levels !== "object") g.levels = {};
  if (!g.economy || typeof g.economy !== "object") g.economy = {};
  if (!g.warnings || typeof g.warnings !== "object") g.warnings = {};
  if (!g.tags || typeof g.tags !== "object") g.tags = {};
  if (!g.giveaways || typeof g.giveaways !== "object") g.giveaways = {};
  if (!g.events || typeof g.events !== "object") g.events = {};
  if (!g.afk || typeof g.afk !== "object") g.afk = {};
  if (typeof g.countingChannelId === "undefined") g.countingChannelId = null;
  if (typeof g.countingNext !== "number" || g.countingNext < 1) g.countingNext = 1;
  if (typeof g.autoRoleId === "undefined") g.autoRoleId = null;
  if (typeof g.welcomeChannelId === "undefined") g.welcomeChannelId = null;
  if (!Array.isArray(g.restrictedWords)) g.restrictedWords = [];
  if (!g.violations || typeof g.violations !== "object") g.violations = { link: {}, word: {} };
  else {
    if (!g.violations.link) g.violations.link = {};
    if (!g.violations.word) g.violations.word = {};
  }
  if (!g.staff || typeof g.staff !== "object") {
    g.staff = { notes: {}, warnings: {}, applicationsOpen: true, applications: [], pay: {}, modeOn: {}, chatChannelId: null, logsChannelId: null };
  } else {
    if (!g.staff.notes) g.staff.notes = {};
    if (!g.staff.warnings) g.staff.warnings = {};
    if (typeof g.staff.applicationsOpen !== "boolean") g.staff.applicationsOpen = true;
    if (!Array.isArray(g.staff.applications)) g.staff.applications = [];
    if (!g.staff.pay) g.staff.pay = {};
    if (!g.staff.modeOn) g.staff.modeOn = {};
  }
  if (!g.nextEventId) g.nextEventId = 1;

  return g;
}

// ---- Activity tracking (voice time + messages) ----

// Debounce disk writes so we don't fsync on every single message/voice event.
let saveTimeout = null;
function scheduleSave() {
  if (saveTimeout) return;
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    saveConfig();
  }, 5000);
}

function getDateKey(date = new Date()) {
  // YYYY-MM-DD — sorts lexicographically same as chronologically, handy for range checks.
  return date.toISOString().slice(0, 10);
}

function ensureUserActivity(guildId, userId) {
  const cfg = ensureGuildConfig(guildId);
  if (!cfg.activity[userId]) {
    cfg.activity[userId] = { voice: {}, messages: {} };
  }
  return cfg.activity[userId];
}

function addVoiceSeconds(guildId, userId, seconds) {
  if (!seconds || seconds <= 0) return;
  const user = ensureUserActivity(guildId, userId);
  const key = getDateKey();
  user.voice[key] = (user.voice[key] || 0) + seconds;
  scheduleSave();
}

function addMessage(guildId, userId, channelId) {
  const user = ensureUserActivity(guildId, userId);
  const key = getDateKey();
  if (!user.messages[key]) user.messages[key] = {};
  user.messages[key][channelId] = (user.messages[key][channelId] || 0) + 1;
  scheduleSave();
}

function getPeriodStartKey(period) {
  const now = new Date();
  if (period === "day") {
    return getDateKey(now);
  }
  if (period === "week") {
    const start = new Date(now);
    start.setDate(start.getDate() - start.getDay()); // back to Sunday
    return getDateKey(start);
  }
  if (period === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return getDateKey(start);
  }
  return "0000-00-00"; // all time
}

function getUserStats(guildId, userId, period) {
  const cfg = ensureGuildConfig(guildId);
  const activity = cfg.activity[userId];
  const startKey = getPeriodStartKey(period);

  let totalVoiceSeconds = 0;
  let totalMessages = 0;
  const channelMessages = {};

  if (activity) {
    for (const [dateKey, seconds] of Object.entries(activity.voice || {})) {
      if (dateKey >= startKey) totalVoiceSeconds += seconds;
    }
    for (const [dateKey, channels] of Object.entries(activity.messages || {})) {
      if (dateKey < startKey) continue;
      for (const [channelId, count] of Object.entries(channels)) {
        channelMessages[channelId] = (channelMessages[channelId] || 0) + count;
        totalMessages += count;
      }
    }
  }

  return { totalVoiceSeconds, totalMessages, channelMessages };
}

function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// ---- Leveling ----

function xpForLevel(level) {
  // XP required to go FROM `level` TO `level + 1`.
  return 5 * level * level + 50 * level + 100;
}

function getLevelData(guildId, userId) {
  const cfg = ensureGuildConfig(guildId);
  if (!cfg.levels[userId]) cfg.levels[userId] = { xp: 0, level: 0, lastGainAt: 0 };
  return cfg.levels[userId];
}

// Gives XP with a light cooldown so people can't spam for levels. Returns
// { leveledUp, level } so the caller can announce a level-up.
function addXp(guildId, userId, amount) {
  const data = getLevelData(guildId, userId);
  const now = Date.now();
  if (now - (data.lastGainAt || 0) < 45_000) {
    return { leveledUp: false, level: data.level };
  }
  data.lastGainAt = now;
  data.xp += amount;

  let leveledUp = false;
  while (data.xp >= xpForLevel(data.level)) {
    data.xp -= xpForLevel(data.level);
    data.level += 1;
    leveledUp = true;
  }
  scheduleSave();
  return { leveledUp, level: data.level };
}

function getLevelLeaderboard(guildId, limit = 10) {
  const cfg = ensureGuildConfig(guildId);
  return Object.entries(cfg.levels)
    .map(([userId, data]) => ({ userId, level: data.level, xp: data.xp }))
    .sort((a, b) => (b.level - a.level) || (b.xp - a.xp))
    .slice(0, limit);
}

// ---- Economy ----

function formatMoney(amount) {
  return `🪙 ${Math.max(0, Math.floor(amount)).toLocaleString("en-US")}`;
}

function getWallet(guildId, userId) {
  const cfg = ensureGuildConfig(guildId);
  if (!cfg.economy[userId]) {
    cfg.economy[userId] = { balance: 0, bank: 0, lastDaily: 0, lastWeekly: 0, lastWork: 0, inventory: [] };
  }
  if (!Array.isArray(cfg.economy[userId].inventory)) cfg.economy[userId].inventory = [];
  return cfg.economy[userId];
}

function addBalance(guildId, userId, amount) {
  const wallet = getWallet(guildId, userId);
  wallet.balance = Math.max(0, wallet.balance + amount);
  scheduleSave();
  return wallet.balance;
}

function getEconomyLeaderboard(guildId, limit = 10) {
  const cfg = ensureGuildConfig(guildId);
  return Object.entries(cfg.economy)
    .map(([userId, w]) => ({ userId, total: (w.balance || 0) + (w.bank || 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

const SHOP_ITEMS = [
  { id: "fishing_rod", name: "🎣 Fishing Rod", price: 250 },
  { id: "lucky_coin", name: "🪙 Lucky Coin", price: 500 },
  { id: "trophy", name: "🏆 Trophy", price: 1000 },
  { id: "vip_pass", name: "🎫 VIP Pass", price: 2500 },
  { id: "crown", name: "👑 Crown", price: 5000 },
];

// ---- Warnings (regular members) ----

function addWarning(guildId, userId, reason, byTag) {
  const cfg = ensureGuildConfig(guildId);
  if (!cfg.warnings[userId]) cfg.warnings[userId] = [];
  const entry = { id: cfg.warnings[userId].length + 1, reason, by: byTag, at: new Date().toISOString() };
  cfg.warnings[userId].push(entry);
  scheduleSave();
  return entry;
}

function getWarnings(guildId, userId) {
  const cfg = ensureGuildConfig(guildId);
  return cfg.warnings[userId] || [];
}

// ---- AFK ----

function setAfk(guildId, userId, reason) {
  const cfg = ensureGuildConfig(guildId);
  cfg.afk[userId] = { reason: reason || "AFK", since: Date.now() };
  scheduleSave();
}

function clearAfk(guildId, userId) {
  const cfg = ensureGuildConfig(guildId);
  if (cfg.afk[userId]) {
    delete cfg.afk[userId];
    scheduleSave();
    return true;
  }
  return false;
}

function getAfk(guildId, userId) {
  const cfg = ensureGuildConfig(guildId);
  return cfg.afk[userId] || null;
}

// ---- Giveaways ----

function parseDurationMs(input) {
  const match = String(input || "").trim().match(/^(\d+)\s*(s|m|h|d|w)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit];
  return amount * unitMs;
}

function pickRandomWinners(pool, count) {
  const copy = [...pool];
  const winners = [];
  while (copy.length && winners.length < count) {
    const idx = Math.floor(Math.random() * copy.length);
    winners.push(copy.splice(idx, 1)[0]);
  }
  return winners;
}

async function endGiveaway(guildId, messageId, { rerolled = false } = {}) {
  const cfg = ensureGuildConfig(guildId);
  const giveaway = cfg.giveaways[messageId];
  if (!giveaway || (giveaway.ended && !rerolled)) return null;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  const channel = guild ? await guild.channels.fetch(giveaway.channelId).catch(() => null) : null;
  const message = channel ? await channel.messages.fetch(messageId).catch(() => null) : null;

  let entries = giveaway.entries || [];
  if (message) {
    const reaction = message.reactions.cache.get("🎉");
    if (reaction) {
      const users = await reaction.users.fetch().catch(() => null);
      if (users) entries = users.filter((u) => !u.bot).map((u) => u.id);
    }
  }

  const winners = pickRandomWinners(entries, giveaway.winnerCount || 1);
  giveaway.ended = true;
  giveaway.winners = winners;
  scheduleSave();

  if (channel) {
    const resultText = winners.length
      ? winners.map((id) => `<@${id}>`).join(", ")
      : "No valid entries — no winner could be picked.";

    await channel.send({
      content: winners.length ? `🎉 Congratulations ${resultText}! You won **${giveaway.prize}**!` : resultText,
      reply: message ? { messageReference: message.id } : undefined,
    }).catch(() => {});

    if (message) {
      const endedEmbed = EmbedBuilder.from(message.embeds[0] || new EmbedBuilder())
        .setColor(0xed4245)
        .setFooter({ text: rerolled ? "Giveaway rerolled" : "Giveaway ended" });
      await message.edit({ embeds: [endedEmbed] }).catch(() => {});
    }
  }

  return winners;
}

// Runs periodically to close out giveaways whose timer has passed.
function startGiveawayScheduler() {
  setInterval(async () => {
    for (const [guildId, g] of Object.entries(config.guilds)) {
      for (const [messageId, giveaway] of Object.entries(g.giveaways || {})) {
        if (!giveaway.ended && !giveaway.paused && giveaway.endsAt <= Date.now()) {
          await endGiveaway(guildId, messageId).catch((err) => console.error("Giveaway end error:", err));
        }
      }
    }
  }, 15_000);
}

// ---- Events ----

function createEventRecord(guildId, data) {
  const cfg = ensureGuildConfig(guildId);
  const id = String(cfg.nextEventId++);
  cfg.events[id] = { id, attendees: [], cancelled: false, ...data };
  scheduleSave();
  return cfg.events[id];
}

function getEvent(guildId, id) {
  const cfg = ensureGuildConfig(guildId);
  return cfg.events[id] || null;
}

// ---- Anti-link & restricted words ----

const LINK_REGEX = /\b((https?:\/\/|www\.)\S+|discord(?:\.gg|app\.com\/invite)\/\S+|[a-zA-Z0-9-]+\.(com|net|org|io|gg|xyz|co|me|link|gift|dev)(\/\S*)?)\b/i;

function containsLink(content) {
  return LINK_REGEX.test(content || "");
}

function findRestrictedWord(guildId, content) {
  const cfg = ensureGuildConfig(guildId);
  if (!cfg.restrictedWords.length) return null;
  const lower = String(content || "").toLowerCase();
  return cfg.restrictedWords.find((w) => lower.includes(w)) || null;
}

// Deletes the offending message; first offense of a given type = warning,
// second (and later) = 1 hour timeout, then the counter resets.
async function applyAutoModeration(message, violationType, reasonLabel) {
  const cfg = ensureGuildConfig(message.guild.id);
  const bucket = cfg.violations[violationType];
  const count = (bucket[message.author.id] || 0) + 1;
  bucket[message.author.id] = count;
  scheduleSave();

  await message.delete().catch(() => {});

  if (count === 1) {
    addWarning(message.guild.id, message.author.id, reasonLabel, client.user.tag);
    await message.channel.send(
      `⚠️ ${message.author}, ${reasonLabel} isn't allowed here. This is your warning — next time you'll be timed out for 1 hour.`,
    ).catch(() => {});
  } else {
    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (member?.moderatable) {
      await member.timeout(3_600_000, reasonLabel).catch(() => {});
      await message.channel.send(`⏱️ ${message.author} has been timed out for 1 hour for repeatedly ${reasonLabel}.`).catch(() => {});
    }
    bucket[message.author.id] = 0;
    scheduleSave();
  }
}

function normalizeTicketType(input) {
  const value = String(input || "support").toLowerCase();
  if (value === "support") return "support";
  if (value === "staffapp" || value === "staff") return "staffapp";
  if (value === "mediaapp" || value === "media") return "mediaapp";
  return "support";
}

function ticketLabel(type) {
  if (type === "support") return "Support";
  if (type === "staffapp") return "Staff App";
  if (type === "mediaapp") return "Media App";
  return "Support";
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "ticket";
}

function parseColor(input) {
  if (!input) return 0x5865f2;
  const cleaned = String(input).trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) return parseInt(cleaned, 16);
  const colors = {
    blurple: 0x5865f2,
    green: 0x57f287,
    red: 0xed4245,
    yellow: 0xfee75c,
    white: 0xffffff,
    black: 0x000000,
    gray: 0x2b2d31,
    grey: 0x2b2d31,
  };
  return colors[cleaned.toLowerCase()] ?? 0x5865f2;
}

function getPrimaryGuildId() {
  if (GUILD_ID) return GUILD_ID;
  const keys = Object.keys(config.guilds);
  return keys[0] || null;
}

function staffRoleLabel(kind, target) {
  return kind === "role" ? `Role • ${target.name}` : `Member • ${target.displayName || target.user?.username || target.username || target.name}`;
}

async function upsertStaffEntry(guild, kind, target, addedByTag) {
  const cfg = ensureGuildConfig(guild.id);
  const existingIndex = cfg.staffEntries.findIndex((entry) => entry.kind === kind && entry.id === target.id);

  const entry = {
    kind,
    id: target.id,
    name: kind === "role" ? target.name : (target.displayName || target.user?.tag || target.tag || target.username || "Member"),
    addedBy: addedByTag,
    addedAt: new Date().toISOString(),
  };

  if (existingIndex >= 0) cfg.staffEntries[existingIndex] = entry;
  else cfg.staffEntries.push(entry);

  saveConfig();
  return entry;
}

function removeStaffEntry(guildId, kind, id) {
  const cfg = ensureGuildConfig(guildId);
  const before = cfg.staffEntries.length;
  cfg.staffEntries = cfg.staffEntries.filter((entry) => !(entry.kind === kind && entry.id === id));
  const changed = cfg.staffEntries.length !== before;
  if (changed) saveConfig();
  return changed;
}

function isOnline(member) {
  const status = member?.presence?.status;
  return status === "online" || status === "idle" || status === "dnd";
}

async function buildStaffPayload(guild) {
  if (!guild) return [];
  const cfg = ensureGuildConfig(guild.id);
  const items = [];

  // Ask the gateway for members + presences so member.presence is populated in cache.
  await guild.members.fetch({ withPresences: true }).catch(() => null);

  for (const entry of cfg.staffEntries) {
    if (entry.kind === "role") {
      const role = await guild.roles.fetch(entry.id).catch(() => null);
      if (!role) continue;

      const onlineMembers = Array.from(role.members.values()).filter(isOnline);
      // Only show this role if at least one member holding it is currently online.
      if (!onlineMembers.length) continue;

      for (const member of onlineMembers) {
        items.push({
          kind: "role",
          id: member.id,
          name: member.displayName || member.user.tag,
          roleLabel: `Role • ${role.name}`,
          status: member.presence.status,
          mention: `<@${member.id}>`,
          avatarUrl: member.displayAvatarURL({ extension: "png", size: 128 }),
        });
      }
      continue;
    }

    const member = await guild.members.fetch(entry.id).catch(() => null);
    if (!member || !isOnline(member)) continue;
    items.push({
      kind: "member",
      id: member.id,
      name: member.displayName || member.user.tag,
      roleLabel: `Member • ${member.roles.highest?.name || "No role"}`,
      status: member.presence.status,
      mention: `<@${member.id}>`,
      avatarUrl: member.displayAvatarURL({ extension: "png", size: 128 }),
    });
  }

  return items;
}

const config = loadConfig();

const commands = [
  new SlashCommandBuilder()
    .setName("ticketlogs")
    .setDescription("Set the ticket logs channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommandGroup((group) =>
      group
        .setName("channel")
        .setDescription("Set the logs channel")
        .addSubcommand((sub) =>
          sub
            .setName("set")
            .setDescription("Set the ticket logs channel")
            .addChannelOption((opt) =>
              opt
                .setName("channel")
                .setDescription("Logs channel")
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true),
            ),
        ),
    ),

  new SlashCommandBuilder()
    .setName("ticketpanel")
    .setDescription("Send the ticket panel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand((sub) =>
      sub
        .setName("send")
        .setDescription("Send the ticket panel")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Channel to send the panel in")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        ),
    ),

  new SlashCommandBuilder()
    .setName("ticketsupp")
    .setDescription("Configure support tickets")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommandGroup((group) =>
      group
        .setName("category")
        .setDescription("Set support ticket category")
        .addSubcommand((sub) =>
          sub
            .setName("set")
            .setDescription("Set the support ticket category")
            .addChannelOption((opt) =>
              opt
                .setName("category")
                .setDescription("Category channel")
                .addChannelTypes(ChannelType.GuildCategory)
                .setRequired(true),
            ),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("perm")
        .setDescription("Set support ticket permissions")
        .addSubcommand((sub) =>
          sub
            .setName("set")
            .setDescription("Add a role or member to support tickets")
            .addMentionableOption((opt) =>
              opt
                .setName("target")
                .setDescription("Role or member")
                .setRequired(true),
            ),
        ),
    ),

  new SlashCommandBuilder()
    .setName("ticketstaffapp")
    .setDescription("Configure staff application tickets")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommandGroup((group) =>
      group
        .setName("category")
        .setDescription("Set staff application category")
        .addSubcommand((sub) =>
          sub
            .setName("set")
            .setDescription("Set the staff application category")
            .addChannelOption((opt) =>
              opt
                .setName("category")
                .setDescription("Category channel")
                .addChannelTypes(ChannelType.GuildCategory)
                .setRequired(true),
            ),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("perm")
        .setDescription("Set staff application permissions")
        .addSubcommand((sub) =>
          sub
            .setName("set")
            .setDescription("Add a role or member to staff application tickets")
            .addMentionableOption((opt) =>
              opt
                .setName("target")
                .setDescription("Role or member")
                .setRequired(true),
            ),
        ),
    ),

  new SlashCommandBuilder()
    .setName("ticketmediaapp")
    .setDescription("Configure media application tickets")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommandGroup((group) =>
      group
        .setName("category")
        .setDescription("Set media application category")
        .addSubcommand((sub) =>
          sub
            .setName("set")
            .setDescription("Set the media application category")
            .addChannelOption((opt) =>
              opt
                .setName("category")
                .setDescription("Category channel")
                .addChannelTypes(ChannelType.GuildCategory)
                .setRequired(true),
            ),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("perm")
        .setDescription("Set media application permissions")
        .addSubcommand((sub) =>
          sub
            .setName("set")
            .setDescription("Add a role or member to media application tickets")
            .addMentionableOption((opt) =>
              opt
                .setName("target")
                .setDescription("Role or member")
                .setRequired(true),
            ),
        ),
    ),

  new SlashCommandBuilder()
    .setName("open")
    .setDescription("Open a ticket manually")
    .addStringOption((opt) =>
      opt
        .setName("type")
        .setDescription("Ticket type")
        .addChoices(
          { name: "Support", value: "support" },
          { name: "Staff App", value: "staffapp" },
          { name: "Media App", value: "mediaapp" },
        )
        .setRequired(false),
    )
    .addMentionableOption((opt) =>
      opt
        .setName("target")
        .setDescription("Role or member to add")
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("close")
    .setDescription("Close the current ticket"),

  new SlashCommandBuilder()
    .setName("embed")
    .setDescription("Send an embed")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((sub) =>
      sub
        .setName("send")
        .setDescription("Send an embed to a channel")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Channel")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("title")
            .setDescription("Embed title")
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("description")
            .setDescription("Embed description")
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("color")
            .setDescription("Embed color hex, for example #5865F2")
            .setRequired(false),
        ),
    ),

  new SlashCommandBuilder()
    .setName("msg")
    .setDescription("Send a message")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((sub) =>
      sub
        .setName("send")
        .setDescription("Send a message to a channel")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Channel")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("message")
            .setDescription("Message content")
            .setRequired(true),
        ),
    ),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((opt) =>
      opt
        .setName("member")
        .setDescription("Member to ban")
        .setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("reason")
        .setDescription("Reason for the ban")
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("staff")
    .setDescription("Manage the live staff list for the website")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Add a role or member to the staff list")
        .addStringOption((opt) =>
          opt
            .setName("kind")
            .setDescription("Choose role or member")
            .addChoices(
              { name: "Role", value: "role" },
              { name: "Member", value: "member" },
            )
            .setRequired(true),
        )
        .addMentionableOption((opt) =>
          opt
            .setName("target")
            .setDescription("Role or member mention")
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("label")
            .setDescription("Optional custom label")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove a staff entry")
        .addStringOption((opt) =>
          opt
            .setName("kind")
            .setDescription("Choose role or member")
            .addChoices(
              { name: "Role", value: "role" },
              { name: "Member", value: "member" },
            )
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("id")
            .setDescription("Role or member ID")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("Show current staff entries"),
    ),

  new SlashCommandBuilder()
    .setName("log")
    .setDescription("View member activity logs")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName("check")
        .setDescription("Check a member's voice time and message activity")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Member to check")
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("period")
            .setDescription("Time range to show")
            .addChoices(
              { name: "Day", value: "day" },
              { name: "Week", value: "week" },
              { name: "Month", value: "month" },
              { name: "All Time", value: "all" },
            )
            .setRequired(true),
        ),
    ),

  // ---------------- Community ----------------
  new SlashCommandBuilder()
    .setName("level")
    .setDescription("Show XP and level")
    .addUserOption((opt) => opt.setName("user").setDescription("Member to check").setRequired(false)),

  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Show level rank on the leaderboard")
    .addUserOption((opt) => opt.setName("user").setDescription("Member to check").setRequired(false)),

  new SlashCommandBuilder()
    .setName("poll")
    .setDescription("Create a reaction poll")
    .addStringOption((opt) => opt.setName("question").setDescription("Poll question").setRequired(true))
    .addStringOption((opt) =>
      opt
        .setName("options")
        .setDescription("Comma-separated options (2-9), leave empty for a Yes/No poll")
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show the server leaderboard")
    .addStringOption((opt) =>
      opt
        .setName("type")
        .setDescription("Which leaderboard to show")
        .addChoices(
          { name: "Level", value: "level" },
          { name: "Economy", value: "economy" },
        )
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("profile")
    .setDescription("Show a member's profile card")
    .addUserOption((opt) => opt.setName("user").setDescription("Member to check").setRequired(false)),

  // ---------------- Moderation ----------------
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption((opt) => opt.setName("member").setDescription("Member to kick").setRequired(true))
    .addStringOption((opt) => opt.setName("reason").setDescription("Reason for the kick").setRequired(false)),

  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout (mute) a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((opt) => opt.setName("member").setDescription("Member to timeout").setRequired(true))
    .addStringOption((opt) =>
      opt.setName("duration").setDescription("Duration, e.g. 10m, 1h, 1d (max 28d)").setRequired(true),
    )
    .addStringOption((opt) => opt.setName("reason").setDescription("Reason for the timeout").setRequired(false)),

  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((opt) => opt.setName("member").setDescription("Member to warn").setRequired(true))
    .addStringOption((opt) => opt.setName("reason").setDescription("Reason for the warning").setRequired(true)),

  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("Show a member's warnings")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((opt) => opt.setName("member").setDescription("Member to check").setRequired(true)),

  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Bulk delete messages")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((opt) =>
      opt.setName("amount").setDescription("Number of messages (1-100)").setMinValue(1).setMaxValue(100).setRequired(true),
    )
    .addUserOption((opt) => opt.setName("user").setDescription("Only delete this user's messages").setRequired(false)),

  new SlashCommandBuilder()
    .setName("lock")
    .setDescription("Lock a channel (deny @everyone Send Messages)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((opt) => opt.setName("channel").setDescription("Channel to lock").setRequired(false))
    .addStringOption((opt) => opt.setName("reason").setDescription("Reason for locking").setRequired(false)),

  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Unlock a previously locked channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((opt) => opt.setName("channel").setDescription("Channel to unlock").setRequired(false)),

  new SlashCommandBuilder()
    .setName("slowmode")
    .setDescription("Set a channel's slowmode")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addIntegerOption((opt) =>
      opt.setName("seconds").setDescription("Seconds between messages (0 to disable)").setMinValue(0).setMaxValue(21600).setRequired(true),
    )
    .addChannelOption((opt) => opt.setName("channel").setDescription("Channel to change").setRequired(false)),

  // ---------------- Economy ----------------
  new SlashCommandBuilder()
    .setName("balance")
    .setDescription("Check wallet and bank balance")
    .addUserOption((opt) => opt.setName("user").setDescription("Member to check").setRequired(false)),

  new SlashCommandBuilder().setName("daily").setDescription("Claim your daily reward"),
  new SlashCommandBuilder().setName("weekly").setDescription("Claim your weekly reward"),
  new SlashCommandBuilder().setName("work").setDescription("Work to earn some coins"),

  new SlashCommandBuilder()
    .setName("deposit")
    .setDescription("Move coins from wallet to bank")
    .addStringOption((opt) => opt.setName("amount").setDescription("Amount, or \"all\"").setRequired(true)),

  new SlashCommandBuilder()
    .setName("withdraw")
    .setDescription("Move coins from bank to wallet")
    .addStringOption((opt) => opt.setName("amount").setDescription("Amount, or \"all\"").setRequired(true)),

  new SlashCommandBuilder()
    .setName("pay")
    .setDescription("Pay another member from your wallet")
    .addUserOption((opt) => opt.setName("user").setDescription("Who to pay").setRequired(true))
    .addIntegerOption((opt) => opt.setName("amount").setDescription("Amount to send").setMinValue(1).setRequired(true)),

  new SlashCommandBuilder()
    .setName("shop")
    .setDescription("Browse or buy from the shop")
    .addStringOption((opt) => opt.setName("item").setDescription("Item id to buy (leave empty to browse)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("inventory")
    .setDescription("Show a member's purchased items")
    .addUserOption((opt) => opt.setName("user").setDescription("Member to check").setRequired(false)),

  // ---------------- Fun ----------------
  new SlashCommandBuilder().setName("meme").setDescription("Get a random meme"),
  new SlashCommandBuilder()
    .setName("8ball")
    .setDescription("Ask the magic 8-ball a question")
    .addStringOption((opt) => opt.setName("question").setDescription("Your question").setRequired(true)),
  new SlashCommandBuilder().setName("coinflip").setDescription("Flip a coin"),
  new SlashCommandBuilder()
    .setName("dice")
    .setDescription("Roll a dice")
    .addIntegerOption((opt) => opt.setName("sides").setDescription("Number of sides (default 6)").setMinValue(2).setMaxValue(1000).setRequired(false)),
  new SlashCommandBuilder()
    .setName("rate")
    .setDescription("Rate anything out of 10")
    .addStringOption((opt) => opt.setName("thing").setDescription("What to rate").setRequired(true)),
  new SlashCommandBuilder()
    .setName("ship")
    .setDescription("Ship two members together")
    .addUserOption((opt) => opt.setName("user1").setDescription("First member").setRequired(true))
    .addUserOption((opt) => opt.setName("user2").setDescription("Second member (default: you)").setRequired(false)),
  new SlashCommandBuilder()
    .setName("afk")
    .setDescription("Set yourself as AFK")
    .addStringOption((opt) => opt.setName("reason").setDescription("AFK reason").setRequired(false)),

  // ---------------- Giveaways ----------------
  new SlashCommandBuilder()
    .setName("gstart")
    .setDescription("Start a giveaway")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) => opt.setName("duration").setDescription("e.g. 30s, 10m, 1h, 1d, 1w").setRequired(true))
    .addIntegerOption((opt) => opt.setName("winners").setDescription("Number of winners").setMinValue(1).setMaxValue(20).setRequired(true))
    .addStringOption((opt) => opt.setName("prize").setDescription("What are you giving away?").setRequired(true))
    .addChannelOption((opt) => opt.setName("channel").setDescription("Channel to post in").setRequired(false)),

  new SlashCommandBuilder()
    .setName("greroll")
    .setDescription("Reroll a giveaway's winners")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) => opt.setName("message_id").setDescription("Giveaway message ID").setRequired(true)),

  new SlashCommandBuilder()
    .setName("gend")
    .setDescription("End a giveaway immediately")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) => opt.setName("message_id").setDescription("Giveaway message ID").setRequired(true)),

  new SlashCommandBuilder()
    .setName("gpause")
    .setDescription("Pause a giveaway's countdown")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) => opt.setName("message_id").setDescription("Giveaway message ID").setRequired(true)),

  new SlashCommandBuilder()
    .setName("gresume")
    .setDescription("Resume a paused giveaway")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) => opt.setName("message_id").setDescription("Giveaway message ID").setRequired(true)),

  // ---------------- Tags ----------------
  new SlashCommandBuilder()
    .setName("tag")
    .setDescription("Manage and use tags")
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("Create a tag")
        .addStringOption((opt) => opt.setName("name").setDescription("Tag name").setRequired(true))
        .addStringOption((opt) => opt.setName("content").setDescription("Tag content").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("edit")
        .setDescription("Edit a tag")
        .addStringOption((opt) => opt.setName("name").setDescription("Tag name").setRequired(true))
        .addStringOption((opt) => opt.setName("content").setDescription("New content").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("delete")
        .setDescription("Delete a tag")
        .addStringOption((opt) => opt.setName("name").setDescription("Tag name").setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("List all tags"))
    .addSubcommand((sub) =>
      sub
        .setName("info")
        .setDescription("Show info about a tag")
        .addStringOption((opt) => opt.setName("name").setDescription("Tag name").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("search")
        .setDescription("Search tags by name")
        .addStringOption((opt) => opt.setName("query").setDescription("Search text").setRequired(true)),
    ),

  // ---------------- Events ----------------
  new SlashCommandBuilder()
    .setName("event")
    .setDescription("Manage server events")
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("Create an event")
        .addStringOption((opt) => opt.setName("name").setDescription("Event name").setRequired(true))
        .addStringOption((opt) => opt.setName("description").setDescription("Event description").setRequired(true))
        .addStringOption((opt) => opt.setName("time").setDescription("When it happens, e.g. 2026-08-10 20:00").setRequired(true))
        .addChannelOption((opt) => opt.setName("channel").setDescription("Channel to announce in").setRequired(false)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("edit")
        .setDescription("Edit an event")
        .addStringOption((opt) => opt.setName("id").setDescription("Event ID").setRequired(true))
        .addStringOption((opt) => opt.setName("name").setDescription("New name").setRequired(false))
        .addStringOption((opt) => opt.setName("description").setDescription("New description").setRequired(false))
        .addStringOption((opt) => opt.setName("time").setDescription("New time").setRequired(false)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("cancel")
        .setDescription("Cancel an event")
        .addStringOption((opt) => opt.setName("id").setDescription("Event ID").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("join")
        .setDescription("Join an event")
        .addStringOption((opt) => opt.setName("id").setDescription("Event ID").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("leave")
        .setDescription("Leave an event")
        .addStringOption((opt) => opt.setName("id").setDescription("Event ID").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("winners")
        .setDescription("Randomly pick winners from attendees")
        .addStringOption((opt) => opt.setName("id").setDescription("Event ID").setRequired(true))
        .addIntegerOption((opt) => opt.setName("count").setDescription("How many winners (default 1)").setMinValue(1).setRequired(false)),
    ),

  // ---------------- Staff+ ----------------
  new SlashCommandBuilder()
    .setName("staffmode")
    .setDescription("Toggle your staff mode status")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("staffchat")
    .setDescription("Send a message to the staff chat channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) => opt.setName("message").setDescription("Message to send").setRequired(true)),

  new SlashCommandBuilder()
    .setName("staffnote")
    .setDescription("Add or view notes about a staff member")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((opt) => opt.setName("user").setDescription("Staff member").setRequired(true))
    .addStringOption((opt) => opt.setName("note").setDescription("Note to add (leave empty to view notes)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("staffwarn")
    .setDescription("Warn a staff member internally")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((opt) => opt.setName("user").setDescription("Staff member").setRequired(true))
    .addStringOption((opt) => opt.setName("reason").setDescription("Reason").setRequired(true)),

  new SlashCommandBuilder()
    .setName("staffhistory")
    .setDescription("Show a staff member's notes and warnings")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((opt) => opt.setName("user").setDescription("Staff member").setRequired(true)),

  new SlashCommandBuilder()
    .setName("staffactivity")
    .setDescription("Check a staff member's voice/message activity")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((opt) => opt.setName("user").setDescription("Staff member").setRequired(true))
    .addStringOption((opt) =>
      opt
        .setName("period")
        .setDescription("Time range")
        .addChoices(
          { name: "Day", value: "day" },
          { name: "Week", value: "week" },
          { name: "Month", value: "month" },
          { name: "All Time", value: "all" },
        )
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("staffmeeting")
    .setDescription("Announce a staff meeting")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) => opt.setName("title").setDescription("Meeting title").setRequired(true))
    .addStringOption((opt) => opt.setName("time").setDescription("When, e.g. 2026-08-10 20:00").setRequired(true))
    .addChannelOption((opt) => opt.setName("channel").setDescription("Channel to announce in").setRequired(false)),

  new SlashCommandBuilder()
    .setName("staffapplications")
    .setDescription("Open, close, or check staff applications status")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt
        .setName("action")
        .setDescription("What to do")
        .addChoices(
          { name: "Open", value: "open" },
          { name: "Close", value: "close" },
          { name: "Status", value: "status" },
        )
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("staffpay")
    .setDescription("Pay a staff member coins for their work")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((opt) => opt.setName("user").setDescription("Staff member").setRequired(true))
    .addIntegerOption((opt) => opt.setName("amount").setDescription("Amount to pay").setMinValue(1).setRequired(true))
    .addStringOption((opt) => opt.setName("note").setDescription("Note, e.g. reason for pay").setRequired(false)),

  new SlashCommandBuilder()
    .setName("stafflogs")
    .setDescription("Set the staff action logs channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("Logs channel")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true),
    ),

  // ---------------- Help ----------------
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show all bot commands")
    .addStringOption((opt) =>
      opt
        .setName("category")
        .setDescription("Show commands from one category")
        .addChoices(
          { name: "Community", value: "community" },
          { name: "Moderation", value: "moderation" },
          { name: "Economy", value: "economy" },
          { name: "Fun", value: "fun" },
          { name: "Giveaways", value: "giveaways" },
          { name: "Tags", value: "tags" },
          { name: "Events", value: "events" },
          { name: "Staff+", value: "staff" },
          { name: "Tickets", value: "tickets" },
        )
        .setRequired(false),
    ),
  // ---------------- Counting / Autorole / Welcome ----------------
  new SlashCommandBuilder()
    .setName("cchannel")
    .setDescription("Manage the counting channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Set the counting channel")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Channel where members count")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    ),

  new SlashCommandBuilder()
    .setName("autorole")
    .setDescription("Manage the auto-role given to new members")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Set the auto-role")
        .addRoleOption((opt) => opt.setName("role").setDescription("Role to auto-assign").setRequired(true)),
    ),

  new SlashCommandBuilder()
    .setName("welcome")
    .setDescription("Manage welcome messages")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommandGroup((group) =>
      group
        .setName("channel")
        .setDescription("Set the welcome channel")
        .addSubcommand((sub) =>
          sub
            .setName("set")
            .setDescription("Set the channel where welcome messages are posted")
            .addChannelOption((opt) =>
              opt
                .setName("channel")
                .setDescription("Welcome channel")
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true),
            ),
        ),
    ),
  new SlashCommandBuilder()
    .setName("restricted")
    .setDescription("Manage restricted words")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommandGroup((group) =>
      group
        .setName("words")
        .setDescription("Manage the restricted words list")
        .addSubcommand((sub) =>
          sub
            .setName("add")
            .setDescription("Add a restricted word")
            .addStringOption((opt) => opt.setName("word").setDescription("Word to restrict").setRequired(true)),
        )
        .addSubcommand((sub) =>
          sub
            .setName("remove")
            .setDescription("Remove a restricted word")
            .addStringOption((opt) => opt.setName("word").setDescription("Word to remove").setRequired(true)),
        )
        .addSubcommand((sub) => sub.setName("list").setDescription("List all restricted words")),
    ),
].map((cmd) => cmd.toJSON());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

// Prevent the whole process from crashing on network hiccups / unhandled errors.
// Without these, an unhandled "error" event or promise rejection kills the bot (SIGTERM/exit).
client.on("error", (err) => console.error("Client error:", err));
client.on("shardError", (err) => console.error("Shard error:", err));
client.on("warn", (msg) => console.warn("Client warning:", msg));
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

// Tracks who is currently in a voice channel and when they joined, so we can
// compute a duration once they leave. Key: `${guildId}:${userId}` -> joinedAt (ms).
const voiceSessions = new Map();

client.on("voiceStateUpdate", (oldState, newState) => {
  const guildId = newState.guild.id;
  const userId = newState.id;
  const key = `${guildId}:${userId}`;
  const wasInVoice = !!oldState.channelId;
  const isInVoice = !!newState.channelId;

  if (!wasInVoice && isInVoice) {
    // Joined a voice channel.
    voiceSessions.set(key, Date.now());
  } else if (wasInVoice && !isInVoice) {
    // Left voice entirely — bank the seconds.
    const joinedAt = voiceSessions.get(key);
    if (joinedAt) {
      const seconds = Math.floor((Date.now() - joinedAt) / 1000);
      addVoiceSeconds(guildId, userId, seconds);
      voiceSessions.delete(key);
    }
  }
  // Switching channels while staying in voice: timer just keeps running.
});

client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;

  // ---- Counting channel: numbers only, must be in sequence ----
  const cfgForCounting = ensureGuildConfig(message.guild.id);
  if (cfgForCounting.countingChannelId && message.channel.id === cfgForCounting.countingChannelId) {
    const content = message.content.trim();
    const isPureNumber = /^\d+$/.test(content);
    const expected = cfgForCounting.countingNext;

    if (!isPureNumber || Number(content) !== expected) {
      await message.delete().catch(() => {});
      return;
    }

    await message.react("✅").catch(() => {});
    cfgForCounting.countingNext = expected + 1;
    scheduleSave();
    return;
  }

  // ---- Anti-link & restricted words (mods/admins are exempt) ----
  const isExempt = message.member?.permissions?.has(PermissionFlagsBits.ManageMessages);
  if (!isExempt) {
    if (containsLink(message.content)) {
      await applyAutoModeration(message, "link", "posting links");
      return;
    }
    const badWord = findRestrictedWord(message.guild.id, message.content);
    if (badWord) {
      await applyAutoModeration(message, "word", "using a restricted word");
      return;
    }
  }

  addMessage(message.guild.id, message.author.id, message.channel.id);

  // Leveling: small XP per message, cooldown handled inside addXp.
  const { leveledUp, level } = addXp(message.guild.id, message.author.id, 15 + Math.floor(Math.random() * 10));
  if (leveledUp) {
    message.channel.send(`🎉 ${message.author} leveled up to **Level ${level}**!`).catch(() => {});
  }

  // AFK: clear the author's own AFK status when they post again.
  if (clearAfk(message.guild.id, message.author.id)) {
    message.channel.send(`👋 Welcome back ${message.author}, I removed your AFK status.`).catch(() => {}).then((sent) => {
      if (sent) setTimeout(() => sent.delete().catch(() => {}), 5000);
    });
  }

  // AFK: let the author know if they pinged someone who is AFK.
  for (const [, mentioned] of message.mentions.users) {
    if (mentioned.bot) continue;
    const afk = getAfk(message.guild.id, mentioned.id);
    if (afk) {
      message.reply(`💤 ${mentioned.username} is AFK: ${afk.reason}`).catch(() => {});
    }
  }
});

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });
    console.log(`Registered guild commands for ${GUILD_ID}`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), {
      body: commands,
    });
    console.log("Registered global commands");
  }
}

function ticketPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🎫 Support Ticket Panel")
    .setDescription(
      [
        "Need help with something? Our support team is here for you!",
        "",
        "Click the button below to open a new ticket, and our team will get back to you as soon as possible.",
        "",
        "📌 Before opening a ticket:",
        "- Clearly describe your issue",
        "- Attach any relevant screenshots or proof",
        "- Please open only one ticket per issue",
        "",
        "⏳ Response Time: Our team typically replies within 24 hours.",
        "",
        "👇 Click the button below to open a ticket",
        "If you want to apply for Media or Staff, please check the requirements category.",
        "",
        "Thanks.",
        "- G1yrex Support Team",
      ].join("\n"),
    );
}

function ticketPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket:create:support")
      .setLabel("Support")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("ticket:create:staffapp")
      .setLabel("Staff App")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ticket:create:mediaapp")
      .setLabel("Media App")
      .setStyle(ButtonStyle.Success),
  );
}

async function sendTicketLog(guild, embed) {
  const cfg = ensureGuildConfig(guild.id);
  if (!cfg.logsChannelId) return false;

  const channel = await guild.channels.fetch(cfg.logsChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return false;

  await channel.send({ embeds: [embed] }).catch(() => {});
  return true;
}

async function createTicketChannel(interaction, type, target = null) {
  const guild = interaction.guild;
  const member = interaction.member;
  const cfg = ensureGuildConfig(guild.id);
  const ticket = cfg.ticketTypes[type];

  if (!ticket?.categoryId) {
    throw new Error(`The category for ${ticketLabel(type)} tickets is not set yet.`);
  }

  const me = guild.members.me || await guild.members.fetchMe();

  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: member.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
    {
      id: me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
  ];

  for (const permId of ticket.permIds || []) {
    overwrites.push({
      id: permId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    });
  }

  if (target) {
    overwrites.push({
      id: target.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    });
  }

  const channel = await guild.channels.create({
    name: `${type}-${slugify(member.user.username)}`,
    type: ChannelType.GuildText,
    parent: ticket.categoryId,
    topic: `Ticket | ${type} | opener:${member.id}`,
    permissionOverwrites: overwrites,
  });

  const notice = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${ticketLabel(type)} Ticket`)
    .setDescription(
      [
        `Hello <@${member.id}>!`,
        "",
        "A staff member will reply as soon as possible.",
        target ? `Added: <@${target.id}>` : null,
        "",
        "Use the button below to close this ticket when you are done.",
      ].filter(Boolean).join("\n"),
    );

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket:close")
      .setLabel("Close Ticket")
      .setStyle(ButtonStyle.Danger),
  );

  await channel.send({
    content: `<@${member.id}>`,
    embeds: [notice],
    components: [closeRow],
  });

  await sendTicketLog(
    guild,
    new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle("Ticket Opened")
      .setDescription(
        [
          `Type: ${ticketLabel(type)}`,
          `Channel: ${channel}`,
          `Opened by: <@${member.id}>`,
          target ? `Added: <@${target.id}>` : null,
        ].filter(Boolean).join("\n"),
      )
      .setTimestamp(),
  );

  return channel;
}

async function closeCurrentTicket(channel, closedByTag) {
  if (!channel?.topic || !channel.topic.startsWith("Ticket |")) {
    return false;
  }

  await channel.send(`Closing ticket requested by ${closedByTag}. This channel will be deleted in 5 seconds.`);

  await sendTicketLog(
    channel.guild,
    new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle("Ticket Closed")
      .setDescription(
        [
          `Channel: ${channel}`,
          `Closed by: ${closedByTag}`,
        ].join("\n"),
      )
      .setTimestamp(),
  );

  setTimeout(() => {
    channel.delete().catch(() => {});
  }, 5000);

  return true;
}

client.on("guildMemberAdd", async (member) => {
  const cfg = ensureGuildConfig(member.guild.id);

  // ---- Auto-role ----
  if (cfg.autoRoleId) {
    const role = await member.guild.roles.fetch(cfg.autoRoleId).catch(() => null);
    if (role) {
      await member.roles.add(role).catch((err) => console.error("Auto-role assign failed:", err));
    }
  }

  // ---- Welcome message ----
  if (cfg.welcomeChannelId) {
    const channel = await member.guild.channels.fetch(cfg.welcomeChannelId).catch(() => null);
    if (channel) {
      const welcomeImagePath = path.join(__dirname, "assets", "welcome.jpg");
      const files = fs.existsSync(welcomeImagePath) ? [new AttachmentBuilder(welcomeImagePath, { name: "welcome.jpg" })] : [];

      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle("Welcome To G1yrex Empire 💙")
        .setDescription("Ownership: G1yrexmc <:Youtube:1505579402983903333>")
        .setImage(files.length ? "attachment://welcome.jpg" : null);

      await channel.send({ content: `${member}`, embeds: [embed], files }).catch((err) => console.error("Welcome message failed:", err));
    }
  }
});

client.once("ready", async () => {
  try {
    await registerCommands();
    startGiveawayScheduler();
    console.log(`Logged in as ${client.user.tag}`);
    client.user.setActivity(`${BOT_NAME} | Sub To G1yrexMC`, { type: 2 });
  } catch (error) {
    console.error("Failed to register commands:", error);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("ticket:create:")) {
        const type = normalizeTicketType(interaction.customId.split(":")[2]);
        const channel = await createTicketChannel(interaction, type, null);
        return interaction.reply({
          content: `Ticket created: ${channel}`,
          ephemeral: true,
        });
      }

      if (interaction.customId === "ticket:close") {
        const closed = await closeCurrentTicket(interaction.channel, interaction.user.tag);
        if (!closed) {
          return interaction.reply({
            content: "This does not look like a ticket channel.",
            ephemeral: true,
          });
        }
        return interaction.reply({
          content: "Ticket is being closed.",
          ephemeral: true,
        });
      }
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "ticketlogs") {
      const group = interaction.options.getSubcommandGroup();
      const sub = interaction.options.getSubcommand();

      if (group === "channel" && sub === "set") {
        const channel = interaction.options.getChannel("channel", true);
        const cfg = ensureGuildConfig(interaction.guild.id);
        cfg.logsChannelId = channel.id;
        saveConfig();

        return interaction.reply({
          content: `Ticket logs channel set to ${channel}.`,
          ephemeral: true,
        });
      }
    }

    if (interaction.commandName === "ticketpanel") {
      const sub = interaction.options.getSubcommand();
      if (sub === "send") {
        const channel = interaction.options.getChannel("channel", true);
        await channel.send({
          embeds: [ticketPanelEmbed()],
          components: [ticketPanelRow()],
        });
        return interaction.reply({
          content: `Ticket panel sent to ${channel}.`,
          ephemeral: true,
        });
      }
    }

    if (
      interaction.commandName === "ticketsupp" ||
      interaction.commandName === "ticketstaffapp" ||
      interaction.commandName === "ticketmediaapp"
    ) {
      const key =
        interaction.commandName === "ticketsupp"
          ? "support"
          : interaction.commandName === "ticketstaffapp"
          ? "staffapp"
          : "mediaapp";

      const group = interaction.options.getSubcommandGroup();
      const sub = interaction.options.getSubcommand();
      const cfg = ensureGuildConfig(interaction.guild.id);
      const ticket = cfg.ticketTypes[key];

      if (group === "category" && sub === "set") {
        const category = interaction.options.getChannel("category", true);
        ticket.categoryId = category.id;
        saveConfig();
        return interaction.reply({
          content: `${ticketLabel(key)} ticket category set to ${category}.`,
          ephemeral: true,
        });
      }

      if (group === "perm" && sub === "set") {
        const target = interaction.options.getMentionable("target", true);
        if (!ticket.permIds.includes(target.id)) {
          ticket.permIds.push(target.id);
          saveConfig();
        }
        return interaction.reply({
          content: `${ticketLabel(key)} ticket permission added for <@${target.id}>.`,
          ephemeral: true,
        });
      }
    }

    if (interaction.commandName === "open") {
      const type = normalizeTicketType(interaction.options.getString("type") || "support");
      const target = interaction.options.getMentionable("target") || null;
      const channel = await createTicketChannel(interaction, type, target);
      return interaction.reply({
        content: `Ticket created: ${channel}`,
        ephemeral: true,
      });
    }

    if (interaction.commandName === "close") {
      const closed = await closeCurrentTicket(interaction.channel, interaction.user.tag);
      if (!closed) {
        return interaction.reply({
          content: "This does not look like a ticket channel.",
          ephemeral: true,
        });
      }
      return interaction.reply({
        content: "Ticket is being closed.",
        ephemeral: true,
      });
    }

    if (interaction.commandName === "embed") {
      const sub = interaction.options.getSubcommand();
      if (sub === "send") {
        const channel = interaction.options.getChannel("channel", true);
        const title = interaction.options.getString("title", true);
        const description = interaction.options.getString("description", true);
        const color = interaction.options.getString("color");

        const embed = new EmbedBuilder()
          .setColor(parseColor(color))
          .setTitle(title)
          .setDescription(description);

        await channel.send({ embeds: [embed] });
        return interaction.reply({
          content: `Embed sent to ${channel}.`,
          ephemeral: true,
        });
      }
    }

    if (interaction.commandName === "msg") {
      const sub = interaction.options.getSubcommand();
      if (sub === "send") {
        const channel = interaction.options.getChannel("channel", true);
        const message = interaction.options.getString("message", true);

        await channel.send({ content: message });
        return interaction.reply({
          content: `Message sent to ${channel}.`,
          ephemeral: true,
        });
      }
    }

    if (interaction.commandName === "ban") {
      const member = interaction.options.getUser("member", true);
      const reason = interaction.options.getString("reason") || "No reason provided.";

      const guildMember = await interaction.guild.members.fetch(member.id).catch(() => null);
      if (!guildMember) {
        return interaction.reply({
          content: "I could not find that member in this server.",
          ephemeral: true,
        });
      }

      await guildMember.ban({ reason: `${reason} | Banned by ${interaction.user.tag}` });
      return interaction.reply({
        content: `${member.tag} has been banned.`,
        ephemeral: true,
      });
    }

    if (interaction.commandName === "staff") {
      const sub = interaction.options.getSubcommand();

      if (sub === "set") {
        const kind = interaction.options.getString("kind", true);
        const target = interaction.options.getMentionable("target", true);
        const label = interaction.options.getString("label") || null;
        const isRole = !!target.permissions;

        if (kind === "role" && !isRole) {
          return interaction.reply({ content: "Please choose a role for kind = role.", ephemeral: true });
        }
        if (kind === "member" && isRole) {
          return interaction.reply({ content: "Please choose a user/member for kind = member.", ephemeral: true });
        }

        if (kind === "member") {
          const member = await interaction.guild.members.fetch(target.id).catch(() => null);
          if (!member) {
            return interaction.reply({ content: "That member is not in this server.", ephemeral: true });
          }
          const saved = await upsertStaffEntry(interaction.guild, "member", member, interaction.user.tag);
          if (label) saved.name = label;
        } else {
          const saved = await upsertStaffEntry(interaction.guild, "role", target, interaction.user.tag);
          if (label) saved.name = label;
        }

        return interaction.reply({
          content: `Staff entry saved for ${kind === "role" ? `<@&${target.id}>` : `<@${target.id}>`}.`,
          ephemeral: true,
        });
      }

      if (sub === "remove") {
        const kind = interaction.options.getString("kind", true);
        const id = interaction.options.getString("id", true);
        const changed = removeStaffEntry(interaction.guild.id, kind, id);
        return interaction.reply({
          content: changed ? "Staff entry removed." : "No matching staff entry was found.",
          ephemeral: true,
        });
      }

      if (sub === "list") {
        const cfg = ensureGuildConfig(interaction.guild.id);
        const lines = cfg.staffEntries.length
          ? cfg.staffEntries.map((entry) => `• ${entry.kind.toUpperCase()}: ${entry.id} (${entry.name || "Unnamed"})`)
          : ["No staff entries saved yet."];
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("Staff Entries")
          .setDescription(lines.join("\n"));
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }
    }

    if (interaction.commandName === "log") {
      const sub = interaction.options.getSubcommand();

      if (sub === "check") {
        const user = interaction.options.getUser("user", true);
        const period = interaction.options.getString("period", true);

        const stats = getUserStats(interaction.guild.id, user.id, period);
        // Weekly requirement is always measured against the week, regardless
        // of which period the mod chose to view.
        const weekly = getUserStats(interaction.guild.id, user.id, "week");

        const VOICE_LIMIT_HOURS = 10;
        const MESSAGE_LIMIT = 100;

        const weeklyVoiceHours = weekly.totalVoiceSeconds / 3600;
        const bestChannelEntry = Object.entries(weekly.channelMessages).sort((a, b) => b[1] - a[1])[0];
        const bestChannelId = bestChannelEntry?.[0] || null;
        const bestChannelCount = bestChannelEntry?.[1] || 0;

        const voiceMet = weeklyVoiceHours >= VOICE_LIMIT_HOURS;
        const msgMet = bestChannelCount >= MESSAGE_LIMIT;

        const topChannelsText = Object.entries(stats.channelMessages)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([channelId, count]) => `<#${channelId}>: ${count}`)
          .join("\n") || "No messages in this period.";

        const periodLabel = { day: "Today", week: "This Week", month: "This Month", all: "All Time" }[period];

        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`Activity Log — ${user.tag}`)
          .setDescription(`Period: **${periodLabel}**`)
          .setThumbnail(user.displayAvatarURL({ extension: "png", size: 128 }))
          .addFields(
            { name: "🎙️ Voice Time", value: formatDuration(stats.totalVoiceSeconds), inline: true },
            { name: "💬 Total Messages", value: `${stats.totalMessages}`, inline: true },
            { name: "📊 Top Channels", value: topChannelsText, inline: false },
            {
              name: "✅ Weekly Requirement (10h VC / 100 msgs in any one chat)",
              value: [
                `Voice: ${weeklyVoiceHours.toFixed(1)}h / ${VOICE_LIMIT_HOURS}h — ${voiceMet ? "✅ Met" : "❌ Not met"}`,
                `Messages: ${bestChannelCount}${bestChannelId ? ` in <#${bestChannelId}>` : ""} / ${MESSAGE_LIMIT} — ${msgMet ? "✅ Met" : "❌ Not met"}`,
              ].join("\n"),
              inline: false,
            },
          )
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }
    }

    // ---------------- Community ----------------
    if (interaction.commandName === "level") {
      const user = interaction.options.getUser("user") || interaction.user;
      const data = getLevelData(interaction.guild.id, user.id);
      const needed = xpForLevel(data.level);
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`${user.username}'s Level`)
        .setThumbnail(user.displayAvatarURL({ extension: "png", size: 128 }))
        .addFields(
          { name: "Level", value: `${data.level}`, inline: true },
          { name: "XP", value: `${data.xp} / ${needed}`, inline: true },
        );
      return interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === "rank") {
      const user = interaction.options.getUser("user") || interaction.user;
      const board = getLevelLeaderboard(interaction.guild.id, 100000);
      const position = board.findIndex((entry) => entry.userId === user.id);
      const data = getLevelData(interaction.guild.id, user.id);
      return interaction.reply({
        content: position === -1
          ? `${user.username} isn't ranked yet — send some messages to earn XP!`
          : `${user.username} is rank **#${position + 1}** (Level ${data.level}, ${data.xp} XP).`,
      });
    }

    if (interaction.commandName === "poll") {
      const question = interaction.options.getString("question", true);
      const optionsRaw = interaction.options.getString("options");
      const numberEmojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];

      let options = optionsRaw ? optionsRaw.split(",").map((s) => s.trim()).filter(Boolean) : null;
      if (options && (options.length < 2 || options.length > 9)) {
        return interaction.reply({ content: "Please provide between 2 and 9 options.", ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("📊 " + question)
        .setFooter({ text: `Poll by ${interaction.user.tag}` });

      if (options) {
        embed.setDescription(options.map((opt, i) => `${numberEmojis[i]} ${opt}`).join("\n"));
      }

      await interaction.reply({ embeds: [embed], fetchReply: true });
      const sent = await interaction.fetchReply();

      const reactions = options ? numberEmojis.slice(0, options.length) : ["👍", "👎"];
      for (const emoji of reactions) {
        await sent.react(emoji).catch(() => {});
      }
      return;
    }

    if (interaction.commandName === "leaderboard") {
      const type = interaction.options.getString("type", true);
      if (type === "level") {
        const board = getLevelLeaderboard(interaction.guild.id, 10);
        const lines = board.length
          ? board.map((e, i) => `**${i + 1}.** <@${e.userId}> — Level ${e.level} (${e.xp} XP)`)
          : ["No one has earned XP yet."];
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle("🏆 Level Leaderboard").setDescription(lines.join("\n"));
        return interaction.reply({ embeds: [embed] });
      } else {
        const board = getEconomyLeaderboard(interaction.guild.id, 10);
        const lines = board.length
          ? board.map((e, i) => `**${i + 1}.** <@${e.userId}> — ${formatMoney(e.total)}`)
          : ["No one has any coins yet."];
        const embed = new EmbedBuilder().setColor(0x57f287).setTitle("🏆 Economy Leaderboard").setDescription(lines.join("\n"));
        return interaction.reply({ embeds: [embed] });
      }
    }

    if (interaction.commandName === "profile") {
      const user = interaction.options.getUser("user") || interaction.user;
      const level = getLevelData(interaction.guild.id, user.id);
      const wallet = getWallet(interaction.guild.id, user.id);
      const warningsCount = getWarnings(interaction.guild.id, user.id).length;
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`${user.username}'s Profile`)
        .setThumbnail(user.displayAvatarURL({ extension: "png", size: 128 }))
        .addFields(
          { name: "Level", value: `${level.level} (${level.xp} XP)`, inline: true },
          { name: "Wallet", value: formatMoney(wallet.balance), inline: true },
          { name: "Bank", value: formatMoney(wallet.bank), inline: true },
          { name: "Warnings", value: `${warningsCount}`, inline: true },
          { name: "Joined Server", value: member?.joinedAt ? `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:D>` : "Unknown", inline: true },
        );
      return interaction.reply({ embeds: [embed] });
    }

    // ---------------- Moderation ----------------
    if (interaction.commandName === "kick") {
      const target = interaction.options.getUser("member", true);
      const reason = interaction.options.getString("reason") || "No reason provided.";
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!member) return interaction.reply({ content: "That member isn't in this server.", ephemeral: true });
      if (!member.kickable) return interaction.reply({ content: "I can't kick that member (role hierarchy).", ephemeral: true });

      await member.kick(`${reason} | Kicked by ${interaction.user.tag}`);
      return interaction.reply({ content: `👢 ${target.tag} has been kicked. Reason: ${reason}` });
    }

    if (interaction.commandName === "timeout") {
      const target = interaction.options.getUser("member", true);
      const durationInput = interaction.options.getString("duration", true);
      const reason = interaction.options.getString("reason") || "No reason provided.";
      const ms = parseDurationMs(durationInput);

      if (!ms || ms > 28 * 86_400_000) {
        return interaction.reply({ content: "Invalid duration. Use formats like 10m, 1h, 1d (max 28d).", ephemeral: true });
      }

      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!member) return interaction.reply({ content: "That member isn't in this server.", ephemeral: true });
      if (!member.moderatable) return interaction.reply({ content: "I can't timeout that member (role hierarchy).", ephemeral: true });

      await member.timeout(ms, `${reason} | By ${interaction.user.tag}`);
      return interaction.reply({ content: `⏱️ ${target.tag} has been timed out for ${durationInput}. Reason: ${reason}` });
    }

    if (interaction.commandName === "warn") {
      const target = interaction.options.getUser("member", true);
      const reason = interaction.options.getString("reason", true);
      const entry = addWarning(interaction.guild.id, target.id, reason, interaction.user.tag);
      await target.send(`⚠️ You were warned in **${interaction.guild.name}**: ${reason}`).catch(() => {});
      return interaction.reply({ content: `⚠️ ${target.tag} has been warned (#${entry.id}). Reason: ${reason}` });
    }

    if (interaction.commandName === "warnings") {
      const target = interaction.options.getUser("member", true);
      const list = getWarnings(interaction.guild.id, target.id);
      const lines = list.length
        ? list.map((w) => `**#${w.id}** — ${w.reason} _(by ${w.by}, <t:${Math.floor(new Date(w.at).getTime() / 1000)}:R>)_`)
        : ["No warnings on record."];
      const embed = new EmbedBuilder().setColor(0xfee75c).setTitle(`Warnings — ${target.tag}`).setDescription(lines.join("\n"));
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === "clear") {
      const amount = interaction.options.getInteger("amount", true);
      const targetUser = interaction.options.getUser("user");
      await interaction.deferReply({ ephemeral: true });

      const fetched = await interaction.channel.messages.fetch({ limit: 100 });
      const toDelete = targetUser
        ? fetched.filter((m) => m.author.id === targetUser.id).first(amount)
        : fetched.first(amount);

      const deleted = await interaction.channel.bulkDelete(toDelete, true).catch(() => null);
      return interaction.editReply({ content: `🧹 Deleted ${deleted?.size ?? 0} message(s).` });
    }

    if (interaction.commandName === "lock" || interaction.commandName === "unlock") {
      const channel = interaction.options.getChannel("channel") || interaction.channel;
      const locking = interaction.commandName === "lock";
      const reason = interaction.options.getString("reason") || null;

      await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
        SendMessages: locking ? false : null,
      });

      return interaction.reply({
        content: locking
          ? `🔒 ${channel} has been locked.${reason ? ` Reason: ${reason}` : ""}`
          : `🔓 ${channel} has been unlocked.`,
      });
    }

    if (interaction.commandName === "slowmode") {
      const seconds = interaction.options.getInteger("seconds", true);
      const channel = interaction.options.getChannel("channel") || interaction.channel;
      await channel.setRateLimitPerUser(seconds);
      return interaction.reply({
        content: seconds === 0 ? `Slowmode disabled in ${channel}.` : `🐌 Slowmode set to ${seconds}s in ${channel}.`,
      });
    }

    // ---------------- Economy ----------------
    if (interaction.commandName === "balance") {
      const user = interaction.options.getUser("user") || interaction.user;
      const wallet = getWallet(interaction.guild.id, user.id);
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle(`${user.username}'s Balance`)
        .addFields(
          { name: "Wallet", value: formatMoney(wallet.balance), inline: true },
          { name: "Bank", value: formatMoney(wallet.bank), inline: true },
        );
      return interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === "daily") {
      const wallet = getWallet(interaction.guild.id, interaction.user.id);
      const now = Date.now();
      if (now - wallet.lastDaily < 86_400_000) {
        const remaining = 86_400_000 - (now - wallet.lastDaily);
        return interaction.reply({ content: `⏳ You already claimed your daily. Try again in ${formatDuration(Math.floor(remaining / 1000))}.`, ephemeral: true });
      }
      wallet.lastDaily = now;
      const amount = 200;
      addBalance(interaction.guild.id, interaction.user.id, amount);
      return interaction.reply({ content: `💰 You claimed your daily reward of ${formatMoney(amount)}!` });
    }

    if (interaction.commandName === "weekly") {
      const wallet = getWallet(interaction.guild.id, interaction.user.id);
      const now = Date.now();
      if (now - wallet.lastWeekly < 604_800_000) {
        const remaining = 604_800_000 - (now - wallet.lastWeekly);
        return interaction.reply({ content: `⏳ You already claimed your weekly. Try again in ${formatDuration(Math.floor(remaining / 1000))}.`, ephemeral: true });
      }
      wallet.lastWeekly = now;
      const amount = 1000;
      addBalance(interaction.guild.id, interaction.user.id, amount);
      return interaction.reply({ content: `💰 You claimed your weekly reward of ${formatMoney(amount)}!` });
    }

    if (interaction.commandName === "work") {
      const wallet = getWallet(interaction.guild.id, interaction.user.id);
      const now = Date.now();
      if (now - wallet.lastWork < 3_600_000) {
        const remaining = 3_600_000 - (now - wallet.lastWork);
        return interaction.reply({ content: `⏳ You're tired. Try working again in ${formatDuration(Math.floor(remaining / 1000))}.`, ephemeral: true });
      }
      wallet.lastWork = now;
      const amount = 50 + Math.floor(Math.random() * 150);
      addBalance(interaction.guild.id, interaction.user.id, amount);
      const jobs = ["delivered packages", "fixed a bug", "walked some dogs", "streamed on Discord", "helped a neighbor"];
      const job = jobs[Math.floor(Math.random() * jobs.length)];
      return interaction.reply({ content: `🛠️ You ${job} and earned ${formatMoney(amount)}!` });
    }

    if (interaction.commandName === "deposit" || interaction.commandName === "withdraw") {
      const wallet = getWallet(interaction.guild.id, interaction.user.id);
      const isDeposit = interaction.commandName === "deposit";
      const source = isDeposit ? wallet.balance : wallet.bank;
      const raw = interaction.options.getString("amount", true).trim().toLowerCase();
      const amount = raw === "all" ? source : Number(raw);

      if (!Number.isFinite(amount) || amount <= 0 || amount > source) {
        return interaction.reply({ content: "Invalid amount.", ephemeral: true });
      }

      if (isDeposit) {
        wallet.balance -= amount;
        wallet.bank += amount;
      } else {
        wallet.bank -= amount;
        wallet.balance += amount;
      }
      scheduleSave();
      return interaction.reply({ content: `${isDeposit ? "🏦 Deposited" : "💵 Withdrew"} ${formatMoney(amount)}.` });
    }

    if (interaction.commandName === "pay") {
      const target = interaction.options.getUser("user", true);
      const amount = interaction.options.getInteger("amount", true);
      if (target.id === interaction.user.id) return interaction.reply({ content: "You can't pay yourself.", ephemeral: true });

      const senderWallet = getWallet(interaction.guild.id, interaction.user.id);
      if (senderWallet.balance < amount) return interaction.reply({ content: "You don't have enough coins in your wallet.", ephemeral: true });

      senderWallet.balance -= amount;
      addBalance(interaction.guild.id, target.id, amount);
      scheduleSave();
      return interaction.reply({ content: `💸 You paid ${formatMoney(amount)} to ${target.tag}.` });
    }

    if (interaction.commandName === "shop") {
      const itemId = interaction.options.getString("item");
      if (!itemId) {
        const lines = SHOP_ITEMS.map((item) => `${item.name} — ${formatMoney(item.price)} _(id: \`${item.id}\`)_`);
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle("🛒 Shop").setDescription(lines.join("\n"));
        return interaction.reply({ embeds: [embed] });
      }

      const item = SHOP_ITEMS.find((i) => i.id === itemId.toLowerCase());
      if (!item) return interaction.reply({ content: "That item doesn't exist. Use `/shop` with no item to browse.", ephemeral: true });

      const wallet = getWallet(interaction.guild.id, interaction.user.id);
      if (wallet.balance < item.price) return interaction.reply({ content: "You don't have enough coins for that.", ephemeral: true });

      wallet.balance -= item.price;
      wallet.inventory.push({ id: item.id, name: item.name, boughtAt: new Date().toISOString() });
      scheduleSave();
      return interaction.reply({ content: `✅ You bought ${item.name} for ${formatMoney(item.price)}!` });
    }

    if (interaction.commandName === "inventory") {
      const user = interaction.options.getUser("user") || interaction.user;
      const wallet = getWallet(interaction.guild.id, user.id);
      const lines = wallet.inventory.length
        ? wallet.inventory.map((i) => `${i.name}`)
        : ["Empty."];
      const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`${user.username}'s Inventory`).setDescription(lines.join("\n"));
      return interaction.reply({ embeds: [embed] });
    }

    // ---------------- Fun ----------------
    if (interaction.commandName === "meme") {
      await interaction.deferReply();
      try {
        const res = await fetch("https://meme-api.com/gimme");
        const data = await res.json();
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(data.title || "Meme").setImage(data.url).setFooter({ text: `👍 ${data.ups ?? 0} • r/${data.subreddit ?? "memes"}` });
        return interaction.editReply({ embeds: [embed] });
      } catch {
        return interaction.editReply({ content: "Couldn't fetch a meme right now, try again later." });
      }
    }

    if (interaction.commandName === "8ball") {
      const question = interaction.options.getString("question", true);
      const answers = [
        "It is certain.", "Without a doubt.", "Yes, definitely.", "You may rely on it.",
        "Most likely.", "Outlook good.", "Signs point to yes.", "Reply hazy, try again.",
        "Ask again later.", "Cannot predict now.", "Don't count on it.", "My reply is no.",
        "Outlook not so good.", "Very doubtful.",
      ];
      const answer = answers[Math.floor(Math.random() * answers.length)];
      return interaction.reply({ content: `🎱 **Q:** ${question}\n**A:** ${answer}` });
    }

    if (interaction.commandName === "coinflip") {
      return interaction.reply({ content: `🪙 ${Math.random() < 0.5 ? "Heads" : "Tails"}!` });
    }

    if (interaction.commandName === "dice") {
      const sides = interaction.options.getInteger("sides") || 6;
      const roll = 1 + Math.floor(Math.random() * sides);
      return interaction.reply({ content: `🎲 You rolled a **${roll}** (out of ${sides}).` });
    }

    if (interaction.commandName === "rate") {
      const thing = interaction.options.getString("thing", true);
      const score = Math.floor(Math.random() * 11);
      return interaction.reply({ content: `📊 I'd rate "${thing}" a **${score}/10**.` });
    }

    if (interaction.commandName === "ship") {
      const user1 = interaction.options.getUser("user1", true);
      const user2 = interaction.options.getUser("user2") || interaction.user;
      const seed = [...(user1.id + user2.id)].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
      const percent = seed % 101;
      const bar = "❤️".repeat(Math.round(percent / 10)) + "🖤".repeat(10 - Math.round(percent / 10));
      return interaction.reply({ content: `💘 ${user1.username} + ${user2.username} = **${percent}%**\n${bar}` });
    }

    if (interaction.commandName === "afk") {
      const reason = interaction.options.getString("reason") || "AFK";
      setAfk(interaction.guild.id, interaction.user.id, reason);
      return interaction.reply({ content: `💤 You are now AFK: ${reason}` });
    }

    // ---------------- Giveaways ----------------
    if (interaction.commandName === "gstart") {
      const durationInput = interaction.options.getString("duration", true);
      const winnerCount = interaction.options.getInteger("winners", true);
      const prize = interaction.options.getString("prize", true);
      const channel = interaction.options.getChannel("channel") || interaction.channel;

      const ms = parseDurationMs(durationInput);
      if (!ms) return interaction.reply({ content: "Invalid duration. Use formats like 30s, 10m, 1h, 1d, 1w.", ephemeral: true });

      const endsAt = Date.now() + ms;
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("🎉 Giveaway!")
        .setDescription([
          `**Prize:** ${prize}`,
          `**Winners:** ${winnerCount}`,
          `**Ends:** <t:${Math.floor(endsAt / 1000)}:R>`,
          `**Hosted by:** ${interaction.user}`,
          "",
          "React with 🎉 to enter!",
        ].join("\n"));

      await interaction.reply({ content: "Giveaway started!", ephemeral: true });
      const sent = await channel.send({ embeds: [embed] });
      await sent.react("🎉").catch(() => {});

      const cfg = ensureGuildConfig(interaction.guild.id);
      cfg.giveaways[sent.id] = {
        channelId: channel.id, prize, winnerCount, endsAt, hostId: interaction.user.id,
        ended: false, paused: false, remainingMs: null, entries: [],
      };
      scheduleSave();
      return;
    }

    if (["greroll", "gend", "gpause", "gresume"].includes(interaction.commandName)) {
      const messageId = interaction.options.getString("message_id", true);
      const cfg = ensureGuildConfig(interaction.guild.id);
      const giveaway = cfg.giveaways[messageId];
      if (!giveaway) return interaction.reply({ content: "No giveaway found with that message ID.", ephemeral: true });

      if (interaction.commandName === "greroll") {
        await interaction.reply({ content: "Rerolling...", ephemeral: true });
        await endGiveaway(interaction.guild.id, messageId, { rerolled: true });
        return;
      }

      if (interaction.commandName === "gend") {
        if (giveaway.ended) return interaction.reply({ content: "That giveaway already ended.", ephemeral: true });
        await interaction.reply({ content: "Ending giveaway...", ephemeral: true });
        await endGiveaway(interaction.guild.id, messageId);
        return;
      }

      if (interaction.commandName === "gpause") {
        if (giveaway.ended) return interaction.reply({ content: "That giveaway already ended.", ephemeral: true });
        giveaway.paused = true;
        giveaway.remainingMs = giveaway.endsAt - Date.now();
        scheduleSave();
        return interaction.reply({ content: "⏸️ Giveaway paused." });
      }

      if (interaction.commandName === "gresume") {
        if (!giveaway.paused) return interaction.reply({ content: "That giveaway isn't paused.", ephemeral: true });
        giveaway.paused = false;
        giveaway.endsAt = Date.now() + (giveaway.remainingMs || 0);
        scheduleSave();
        return interaction.reply({ content: "▶️ Giveaway resumed." });
      }
    }

    // ---------------- Tags ----------------
    if (interaction.commandName === "tag") {
      const sub = interaction.options.getSubcommand();
      const cfg = ensureGuildConfig(interaction.guild.id);
      const canManage = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);

      if (sub === "create") {
        if (!canManage) return interaction.reply({ content: "You need Manage Messages to create tags.", ephemeral: true });
        const name = interaction.options.getString("name", true).toLowerCase();
        const content = interaction.options.getString("content", true);
        if (cfg.tags[name]) return interaction.reply({ content: "A tag with that name already exists.", ephemeral: true });
        cfg.tags[name] = { content, createdBy: interaction.user.tag, createdAt: new Date().toISOString(), uses: 0 };
        scheduleSave();
        return interaction.reply({ content: `✅ Tag \`${name}\` created.` });
      }

      if (sub === "edit") {
        if (!canManage) return interaction.reply({ content: "You need Manage Messages to edit tags.", ephemeral: true });
        const name = interaction.options.getString("name", true).toLowerCase();
        const content = interaction.options.getString("content", true);
        if (!cfg.tags[name]) return interaction.reply({ content: "That tag doesn't exist.", ephemeral: true });
        cfg.tags[name].content = content;
        scheduleSave();
        return interaction.reply({ content: `✅ Tag \`${name}\` updated.` });
      }

      if (sub === "delete") {
        if (!canManage) return interaction.reply({ content: "You need Manage Messages to delete tags.", ephemeral: true });
        const name = interaction.options.getString("name", true).toLowerCase();
        if (!cfg.tags[name]) return interaction.reply({ content: "That tag doesn't exist.", ephemeral: true });
        delete cfg.tags[name];
        scheduleSave();
        return interaction.reply({ content: `🗑️ Tag \`${name}\` deleted.` });
      }

      if (sub === "list") {
        const names = Object.keys(cfg.tags);
        return interaction.reply({ content: names.length ? names.map((n) => `\`${n}\``).join(", ") : "No tags yet." });
      }

      if (sub === "info") {
        const name = interaction.options.getString("name", true).toLowerCase();
        const tag = cfg.tags[name];
        if (!tag) return interaction.reply({ content: "That tag doesn't exist.", ephemeral: true });
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`Tag: ${name}`).addFields(
          { name: "Created by", value: tag.createdBy, inline: true },
          { name: "Uses", value: `${tag.uses}`, inline: true },
        );
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === "search") {
        const query = interaction.options.getString("query", true).toLowerCase();
        const matches = Object.keys(cfg.tags).filter((n) => n.includes(query));
        return interaction.reply({ content: matches.length ? matches.map((n) => `\`${n}\``).join(", ") : "No matching tags." });
      }
    }

    // ---------------- Events ----------------
    if (interaction.commandName === "event") {
      const sub = interaction.options.getSubcommand();
      const cfg = ensureGuildConfig(interaction.guild.id);
      const canManage = interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

      if (sub === "create") {
        if (!canManage) return interaction.reply({ content: "You need Manage Events to create events.", ephemeral: true });
        const name = interaction.options.getString("name", true);
        const description = interaction.options.getString("description", true);
        const time = interaction.options.getString("time", true);
        const channel = interaction.options.getChannel("channel") || interaction.channel;

        const event = createEventRecord(interaction.guild.id, { name, description, time, hostId: interaction.user.id, channelId: channel.id });
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`📅 ${name}`)
          .setDescription(description)
          .addFields(
            { name: "When", value: time, inline: true },
            { name: "Host", value: `<@${event.hostId}>`, inline: true },
            { name: "Event ID", value: event.id, inline: true },
          )
          .setFooter({ text: "Use /event join to attend!" });
        const sent = await channel.send({ embeds: [embed] });
        event.messageId = sent.id;
        scheduleSave();
        return interaction.reply({ content: `✅ Event created (ID: ${event.id}) in ${channel}.`, ephemeral: true });
      }

      const id = interaction.options.getString("id", true);
      const event = getEvent(interaction.guild.id, id);
      if (!event) return interaction.reply({ content: "No event found with that ID.", ephemeral: true });

      if (sub === "edit") {
        if (!canManage) return interaction.reply({ content: "You need Manage Events to edit events.", ephemeral: true });
        const name = interaction.options.getString("name");
        const description = interaction.options.getString("description");
        const time = interaction.options.getString("time");
        if (name) event.name = name;
        if (description) event.description = description;
        if (time) event.time = time;
        scheduleSave();
        return interaction.reply({ content: `✅ Event ${id} updated.` });
      }

      if (sub === "cancel") {
        if (!canManage) return interaction.reply({ content: "You need Manage Events to cancel events.", ephemeral: true });
        event.cancelled = true;
        scheduleSave();
        return interaction.reply({ content: `🚫 Event ${id} cancelled.` });
      }

      if (sub === "join") {
        if (!event.attendees.includes(interaction.user.id)) event.attendees.push(interaction.user.id);
        scheduleSave();
        return interaction.reply({ content: `✅ You joined **${event.name}**.`, ephemeral: true });
      }

      if (sub === "leave") {
        event.attendees = event.attendees.filter((uid) => uid !== interaction.user.id);
        scheduleSave();
        return interaction.reply({ content: `You left **${event.name}**.`, ephemeral: true });
      }

      if (sub === "winners") {
        if (!canManage) return interaction.reply({ content: "You need Manage Events to draw winners.", ephemeral: true });
        const count = interaction.options.getInteger("count") || 1;
        const winners = pickRandomWinners(event.attendees, count);
        return interaction.reply({
          content: winners.length ? `🎉 Winners of **${event.name}**: ${winners.map((id) => `<@${id}>`).join(", ")}` : "No attendees to pick from.",
        });
      }
    }

    // ---------------- Staff+ ----------------
    if (interaction.commandName === "staffmode") {
      const cfg = ensureGuildConfig(interaction.guild.id);
      const on = !cfg.staff.modeOn[interaction.user.id];
      cfg.staff.modeOn[interaction.user.id] = on;
      scheduleSave();
      return interaction.reply({ content: on ? "🟢 Staff mode enabled." : "🔴 Staff mode disabled.", ephemeral: true });
    }

    if (interaction.commandName === "staffchat") {
      const cfg = ensureGuildConfig(interaction.guild.id);
      const message = interaction.options.getString("message", true);
      const channel = cfg.staff.chatChannelId
        ? await interaction.guild.channels.fetch(cfg.staff.chatChannelId).catch(() => null)
        : interaction.channel;

      const embed = new EmbedBuilder().setColor(0x2b2d31).setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() }).setDescription(message);
      await (channel || interaction.channel).send({ embeds: [embed] }).catch(() => {});
      return interaction.reply({ content: "✅ Sent to staff chat.", ephemeral: true });
    }

    if (interaction.commandName === "staffnote") {
      const cfg = ensureGuildConfig(interaction.guild.id);
      const target = interaction.options.getUser("user", true);
      const note = interaction.options.getString("note");

      if (!cfg.staff.notes[target.id]) cfg.staff.notes[target.id] = [];

      if (note) {
        cfg.staff.notes[target.id].push({ note, by: interaction.user.tag, at: new Date().toISOString() });
        scheduleSave();
        return interaction.reply({ content: `📝 Note added for ${target.tag}.`, ephemeral: true });
      }

      const lines = cfg.staff.notes[target.id].length
        ? cfg.staff.notes[target.id].map((n) => `• ${n.note} _(by ${n.by})_`)
        : ["No notes on file."];
      return interaction.reply({ content: lines.join("\n"), ephemeral: true });
    }

    if (interaction.commandName === "staffwarn") {
      const cfg = ensureGuildConfig(interaction.guild.id);
      const target = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason", true);
      if (!cfg.staff.warnings[target.id]) cfg.staff.warnings[target.id] = [];
      cfg.staff.warnings[target.id].push({ reason, by: interaction.user.tag, at: new Date().toISOString() });
      scheduleSave();
      return interaction.reply({ content: `⚠️ Internal staff warning logged for ${target.tag}.`, ephemeral: true });
    }

    if (interaction.commandName === "staffhistory") {
      const cfg = ensureGuildConfig(interaction.guild.id);
      const target = interaction.options.getUser("user", true);
      const notes = cfg.staff.notes[target.id] || [];
      const warns = cfg.staff.warnings[target.id] || [];
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`Staff History — ${target.tag}`)
        .addFields(
          { name: `Notes (${notes.length})`, value: notes.length ? notes.map((n) => `• ${n.note}`).join("\n") : "None", inline: false },
          { name: `Warnings (${warns.length})`, value: warns.length ? warns.map((w) => `• ${w.reason}`).join("\n") : "None", inline: false },
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === "staffactivity") {
      const target = interaction.options.getUser("user", true);
      const period = interaction.options.getString("period", true);
      const stats = getUserStats(interaction.guild.id, target.id, period);
      const periodLabel = { day: "Today", week: "This Week", month: "This Month", all: "All Time" }[period];
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`Staff Activity — ${target.tag}`)
        .setDescription(`Period: **${periodLabel}**`)
        .addFields(
          { name: "🎙️ Voice Time", value: formatDuration(stats.totalVoiceSeconds), inline: true },
          { name: "💬 Messages", value: `${stats.totalMessages}`, inline: true },
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === "staffmeeting") {
      const title = interaction.options.getString("title", true);
      const time = interaction.options.getString("time", true);
      const channel = interaction.options.getChannel("channel") || interaction.channel;
      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle(`📢 Staff Meeting: ${title}`)
        .addFields({ name: "When", value: time })
        .setFooter({ text: `Announced by ${interaction.user.tag}` });
      await channel.send({ content: "@here", embeds: [embed] }).catch(() => {});
      return interaction.reply({ content: "✅ Meeting announced.", ephemeral: true });
    }

    if (interaction.commandName === "staffapplications") {
      const cfg = ensureGuildConfig(interaction.guild.id);
      const action = interaction.options.getString("action", true);
      if (action === "open") cfg.staff.applicationsOpen = true;
      if (action === "close") cfg.staff.applicationsOpen = false;
      scheduleSave();
      return interaction.reply({
        content: `Staff applications are currently **${cfg.staff.applicationsOpen ? "OPEN" : "CLOSED"}** (${cfg.staff.applications.length} on file).`,
        ephemeral: true,
      });
    }

    if (interaction.commandName === "staffpay") {
      const cfg = ensureGuildConfig(interaction.guild.id);
      const target = interaction.options.getUser("user", true);
      const amount = interaction.options.getInteger("amount", true);
      const note = interaction.options.getString("note") || null;

      addBalance(interaction.guild.id, target.id, amount);
      if (!cfg.staff.pay[target.id]) cfg.staff.pay[target.id] = [];
      cfg.staff.pay[target.id].push({ amount, by: interaction.user.tag, note, at: new Date().toISOString() });
      scheduleSave();
      return interaction.reply({ content: `💵 Paid ${formatMoney(amount)} to ${target.tag}.${note ? ` Note: ${note}` : ""}` });
    }

    if (interaction.commandName === "stafflogs") {
      const cfg = ensureGuildConfig(interaction.guild.id);
      const channel = interaction.options.getChannel("channel", true);
      cfg.staff.logsChannelId = channel.id;
      scheduleSave();
      return interaction.reply({ content: `Staff logs channel set to ${channel}.`, ephemeral: true });
    }

    // ---------------- Help ----------------
    if (interaction.commandName === "help") {
      const category = interaction.options.getString("category");
      const categories = {
        community: { title: "🎮 Community", commands: ["/level", "/rank", "/poll", "/leaderboard", "/profile"] },
        moderation: { title: "🛡️ Moderation", commands: ["/ban", "/kick", "/timeout", "/warn", "/warnings", "/clear", "/lock", "/unlock", "/slowmode"] },
        economy: { title: "💰 Economy", commands: ["/balance", "/daily", "/weekly", "/work", "/deposit", "/withdraw", "/pay", "/shop", "/inventory", "/leaderboard"] },
        fun: { title: "🎭 Fun", commands: ["/meme", "/8ball", "/coinflip", "/dice", "/rate", "/ship", "/afk"] },
        giveaways: { title: "🎉 Giveaways", commands: ["/gstart", "/greroll", "/gend", "/gpause", "/gresume"] },
        tags: { title: "🏷️ Tags", commands: ["/tag create", "/tag edit", "/tag delete", "/tag list", "/tag info", "/tag search"] },
        events: { title: "📅 Events", commands: ["/event create", "/event edit", "/event cancel", "/event join", "/event leave", "/event winners"] },
        staff: { title: "👮 Staff+", commands: ["/staffmode", "/staffchat", "/staffnote", "/staffwarn", "/staffhistory", "/staffactivity", "/staffmeeting", "/staffapplications", "/staffpay", "/stafflogs"] },
        tickets: { title: "🎫 Tickets & Setup", commands: ["/ticketlogs", "/ticketpanel", "/ticketsupp", "/ticketstaffapp", "/ticketmediaapp", "/open", "/close", "/staff", "/log check", "/cchannel set", "/autorole set", "/welcome channel set", "/restricted words add", "/restricted words remove", "/restricted words list"] },
      };

      if (category && categories[category]) {
        const cat = categories[category];
        const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(cat.title).setDescription(cat.commands.join("\n"));
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`${BOT_NAME} — Commands`)
        .setDescription("Use `/help category:<name>` to see details for one category.");
      for (const cat of Object.values(categories)) {
        embed.addFields({ name: cat.title, value: cat.commands.join(", ") });
      }
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ---------------- Counting / Autorole / Welcome ----------------
    if (interaction.commandName === "cchannel") {
      const sub = interaction.options.getSubcommand();
      if (sub === "set") {
        const channel = interaction.options.getChannel("channel", true);
        const cfg = ensureGuildConfig(interaction.guild.id);
        cfg.countingChannelId = channel.id;
        cfg.countingNext = 1;
        scheduleSave();
        return interaction.reply({
          content: `🔢 Counting channel set to ${channel}. Members should start counting from **1**. Anything that isn't the next correct number gets deleted automatically.`,
          ephemeral: true,
        });
      }
    }

    if (interaction.commandName === "autorole") {
      const sub = interaction.options.getSubcommand();
      if (sub === "set") {
        const role = interaction.options.getRole("role", true);
        const cfg = ensureGuildConfig(interaction.guild.id);
        cfg.autoRoleId = role.id;
        scheduleSave();
        return interaction.reply({ content: `✅ New members will now automatically receive the ${role} role.`, ephemeral: true });
      }
    }

    if (interaction.commandName === "welcome") {
      const group = interaction.options.getSubcommandGroup();
      const sub = interaction.options.getSubcommand();
      if (group === "channel" && sub === "set") {
        const channel = interaction.options.getChannel("channel", true);
        const cfg = ensureGuildConfig(interaction.guild.id);
        cfg.welcomeChannelId = channel.id;
        scheduleSave();
        return interaction.reply({ content: `👋 Welcome messages will now be posted in ${channel}.`, ephemeral: true });
      }
    }

    if (interaction.commandName === "restricted") {
      const group = interaction.options.getSubcommandGroup();
      const sub = interaction.options.getSubcommand();
      const cfg = ensureGuildConfig(interaction.guild.id);

      if (group === "words") {
        if (sub === "add") {
          const word = interaction.options.getString("word", true).trim().toLowerCase();
          if (cfg.restrictedWords.includes(word)) {
            return interaction.reply({ content: "That word is already restricted.", ephemeral: true });
          }
          cfg.restrictedWords.push(word);
          scheduleSave();
          return interaction.reply({ content: `🚫 Added \`${word}\` to the restricted words list.`, ephemeral: true });
        }

        if (sub === "remove") {
          const word = interaction.options.getString("word", true).trim().toLowerCase();
          if (!cfg.restrictedWords.includes(word)) {
            return interaction.reply({ content: "That word isn't on the list.", ephemeral: true });
          }
          cfg.restrictedWords = cfg.restrictedWords.filter((w) => w !== word);
          scheduleSave();
          return interaction.reply({ content: `✅ Removed \`${word}\` from the restricted words list.`, ephemeral: true });
        }

        if (sub === "list") {
          const list = cfg.restrictedWords.length ? cfg.restrictedWords.map((w) => `\`${w}\``).join(", ") : "No restricted words set.";
          return interaction.reply({ content: list, ephemeral: true });
        }
      }
    }
  } catch (error) {
    console.error(error);

    const message = error?.message || "Something went wrong.";
    if (interaction.replied || interaction.deferred) {
      return interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
    }
    return interaction.reply({ content: message, ephemeral: true }).catch(() => {});
  }
});

const app = express();
app.disable("x-powered-by");
app.use(express.json());
const PUBLIC_DIR = path.join(__dirname, "public");

app.use(express.static(PUBLIC_DIR, {
  extensions: ["html"],
  maxAge: "5m",
}));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/api/staff", async (req, res) => {
  try {
    const guildId = req.query.guildId || getPrimaryGuildId();
    if (!guildId) {
      return res.json({ guildId: null, staff: [] });
    }

    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      return res.json({ guildId, staff: [] });
    }

    const staff = await buildStaffPayload(guild);
    return res.json({ guildId, staff });
  } catch (error) {
    console.error("Staff API error:", error);
    return res.status(500).json({ error: "Failed to load staff." });
  }
});

app.get("/api/status", async (req, res) => {
  const guildId = req.query.guildId || getPrimaryGuildId();
  const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : null;
  const cfg = guild ? ensureGuildConfig(guild.id) : null;
  res.json({
    ok: true,
    guildId,
    botReady: client.isReady(),
    staffEntries: cfg?.staffEntries?.length || 0,
  });
});

app.listen(PORT, () => {
  console.log(`Web server listening on port ${PORT}`);
});

client.login(TOKEN);
