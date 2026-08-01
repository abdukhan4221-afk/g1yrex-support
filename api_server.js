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
    };
  } else {
    if (!Array.isArray(config.guilds[guildId].staffEntries)) {
      config.guilds[guildId].staffEntries = [];
    }
    if (!config.guilds[guildId].activity || typeof config.guilds[guildId].activity !== "object") {
      config.guilds[guildId].activity = {};
    }
  }
  return config.guilds[guildId];
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
].map((cmd) => cmd.toJSON());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.Channel],
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

client.on("messageCreate", (message) => {
  if (!message.guild || message.author.bot) return;
  addMessage(message.guild.id, message.author.id, message.channel.id);
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

client.once("ready", async () => {
  try {
    await registerCommands();
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
