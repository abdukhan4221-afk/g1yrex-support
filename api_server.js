require("dotenv").config();

const fs = require("fs");
const path = require("path");

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

if (!TOKEN || !CLIENT_ID) {
  console.error("Missing TOKEN or CLIENT_ID in .env");
  process.exit(1);
}

const BOT_NAME = "G1yrex Support";
const CONFIG_PATH = path.join(__dirname, "ticket-config.json");

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
    };
  }
  return config.guilds[guildId];
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
                .setRequired(true)
            )
        )
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
            .setRequired(true)
        )
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
                .setRequired(true)
            )
        )
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
                .setRequired(true)
            )
        )
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
                .setRequired(true)
            )
        )
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
                .setRequired(true)
            )
        )
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
                .setRequired(true)
            )
        )
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
                .setRequired(true)
            )
        )
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
          { name: "Media App", value: "mediaapp" }
        )
        .setRequired(false)
    )
    .addMentionableOption((opt) =>
      opt
        .setName("target")
        .setDescription("Role or member to add")
        .setRequired(false)
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
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("title")
            .setDescription("Embed title")
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("description")
            .setDescription("Embed description")
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("color")
            .setDescription("Embed color hex, for example #5865F2")
            .setRequired(false)
        )
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
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("message")
            .setDescription("Message content")
            .setRequired(true)
        )
    ),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((opt) =>
      opt
        .setName("member")
        .setDescription("Member to ban")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("reason")
        .setDescription("Reason for the ban")
        .setRequired(false)
    ),
].map((cmd) => cmd.toJSON());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
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
      ].join("\n")
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
      .setStyle(ButtonStyle.Success)
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
      ].filter(Boolean).join("\n")
    );

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket:close")
      .setLabel("Close Ticket")
      .setStyle(ButtonStyle.Danger)
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
        ].filter(Boolean).join("\n")
      )
      .setTimestamp()
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
        ].join("\n")
      )
      .setTimestamp()
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
  } catch (error) {
    console.error(error);

    const message = error?.message || "Something went wrong.";
    if (interaction.replied || interaction.deferred) {
      return interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
    }
    return interaction.reply({ content: message, ephemeral: true }).catch(() => {});
  }
});

client.login(TOKEN);
