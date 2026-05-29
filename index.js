require("dotenv").config();

const {
	Client,
	GatewayIntentBits,
	SlashCommandBuilder,
	REST,
	Routes,
	GuildScheduledEventPrivacyLevel,
	GuildScheduledEventEntityType,
} = require("discord.js");

const mongoose = require("mongoose");
const { MONGODB_URI } = require("./urls");
const cors = require("cors");

const express = require("express");
const app = express();

app.use(
	cors({
		origin: ["https://www.demoloop.io", "https://demoloop.io"],
	}),
);

const {
	DISCORD_TOKEN,
	CLIENT_ID,
	GUILD_ID,
	MAX_SLOTS_PER_SESSION = 5,
	MAX_SESSIONS_PER_WEEK = 5,
	DEFAULT_TIMEZONE = "UTC",
	DEFAULT_SESSION_DURATION_MINUTES = 60,
	ATTENDANCE_MINUTES_REQUIRED = 30,
	SCHEDULE_LIMIT_DAYS = 21,
	NO_SHOW_WAITLIST_THRESHOLD = 2,
	NO_SHOW_HOST_APPROVAL_THRESHOLD = 3,
	PORT = 3000,
} = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID || !MONGODB_URI) {
	console.error("Missing DISCORD_TOKEN, CLIENT_ID, GUILD_ID, or MONGODB_URI");
	process.exit(1);
}

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.GuildVoiceStates,
	],
});

const dayMap = {
	sunday: 0,
	monday: 1,
	tuesday: 2,
	wednesday: 3,
	thursday: 4,
	friday: 5,
	saturday: 6,
};

const shortDay = {
	sunday: "sun",
	monday: "mon",
	tuesday: "tue",
	wednesday: "wed",
	thursday: "thu",
	friday: "fri",
	saturday: "sat",
};

const displayDay = {
	sunday: "Sunday",
	monday: "Monday",
	tuesday: "Tuesday",
	wednesday: "Wednesday",
	thursday: "Thursday",
	friday: "Friday",
	saturday: "Saturday",
};

/* ----------------------------- SCHEMAS ----------------------------- */

const userSchema = new mongoose.Schema(
	{
		discordId: { type: String, unique: true, index: true },
		username: String,

		currentStreak: { type: Number, default: 0 },
		longestStreak: { type: Number, default: 0 },
		totalPresentations: { type: Number, default: 0 },
		lastPresentedWeek: String,

		totalFeedbackGiven: { type: Number, default: 0 },

		totalSessionsAttended: { type: Number, default: 0 },
		attendanceStreak: { type: Number, default: 0 },
		longestAttendanceStreak: { type: Number, default: 0 },
		lastAttendedWeek: String,

		noShowCount: { type: Number, default: 0 },
	},
	{ timestamps: true },
);

const sessionSchema = new mongoose.Schema(
	{
		sessionCode: { type: String, unique: true, index: true },
		discordEventId: String,
		title: String,
		day: String,
		time: String,
		timezone: { type: String, default: DEFAULT_TIMEZONE },
		weekKey: String,
		scheduledAt: Date,
		endsAt: Date,
		durationMinutes: {
			type: Number,
			default: Number(DEFAULT_SESSION_DURATION_MINUTES),
		},
		maxSlots: Number,
		status: {
			type: String,
			enum: ["scheduled", "live", "ended", "cancelled"],
			default: "scheduled",
		},
		hostDiscordId: String,
		hostUsername: String,
		voiceChannelId: String,
		startedAt: Date,
		endedAt: Date,
		cancelledAt: Date,
	},
	{ timestamps: true },
);

const slotRequestSchema = new mongoose.Schema(
	{
		sessionId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "Session",
			index: true,
		},
		discordId: String,
		username: String,
		title: String,
		improveGoal: String,
		status: {
			type: String,
			enum: ["confirmed", "waitlisted", "left", "no_show"],
			default: "confirmed",
		},
		leftAt: Date,
		noShowAt: Date,
	},
	{ timestamps: true },
);

slotRequestSchema.index({ sessionId: 1, discordId: 1 }, { unique: true });

const participationSchema = new mongoose.Schema(
	{
		sessionId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "Session",
			index: true,
		},
		discordId: String,
		username: String,
		presentedAt: Date,
		weekKey: String,
	},
	{ timestamps: true },
);

participationSchema.index({ sessionId: 1, discordId: 1 }, { unique: true });

const feedbackSchema = new mongoose.Schema(
	{
		sessionId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "Session",
			index: true,
		},
		speakerDiscordId: String,
		speakerUsername: String,
		giverDiscordId: String,
		giverUsername: String,
		clarity: { type: Number, min: 1, max: 10 },
		structure: { type: Number, min: 1, max: 10 },
		delivery: { type: Number, min: 1, max: 10 },
		note: String,
	},
	{ timestamps: true },
);

feedbackSchema.index(
	{ sessionId: 1, speakerDiscordId: 1, giverDiscordId: 1 },
	{ unique: true },
);

const attendanceSchema = new mongoose.Schema(
	{
		sessionId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "Session",
			index: true,
		},
		discordId: String,
		username: String,
		weekKey: String,
		attendedAt: Date,
	},
	{ timestamps: true },
);

attendanceSchema.index({ sessionId: 1, discordId: 1 }, { unique: true });

const attendanceTrackerSchema = new mongoose.Schema(
	{
		sessionId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "Session",
			index: true,
		},
		discordId: String,
		username: String,
		cumulativeMs: { type: Number, default: 0 },
		joinedAt: Date,
		counted: { type: Boolean, default: false },
	},
	{ timestamps: true },
);

attendanceTrackerSchema.index({ sessionId: 1, discordId: 1 }, { unique: true });

const hostInterestSchema = new mongoose.Schema(
	{
		discordId: { type: String, index: true },
		username: String,
		day: String,
		time: String,
		reason: String,
		experience: String,
		status: {
			type: String,
			enum: ["pending", "approved", "rejected"],
			default: "pending",
		},
		reviewedByDiscordId: String,
		reviewedByUsername: String,
		reviewedAt: Date,
	},
	{ timestamps: true },
);

hostInterestSchema.index({ discordId: 1, day: 1, time: 1 }, { unique: true });

const User = mongoose.model("User", userSchema);
const Session = mongoose.model("Session", sessionSchema);
const SlotRequest = mongoose.model("SlotRequest", slotRequestSchema);
const Participation = mongoose.model("Participation", participationSchema);
const Feedback = mongoose.model("Feedback", feedbackSchema);
const Attendance = mongoose.model("Attendance", attendanceSchema);
const AttendanceTracker = mongoose.model(
	"AttendanceTracker",
	attendanceTrackerSchema,
);
const HostInterest = mongoose.model("HostInterest", hostInterestSchema);

app.get("/api/public/stats", async (req, res) => {
	try {
		const now = new Date();
		const sessions = await Session.find({
			status: { $in: ["scheduled", "live"] },
			endsAt: { $gte: now },
		})
			.sort({ scheduledAt: 1 })
			.limit(10)
			.lean();

		const enrichedSessions = await Promise.all(
			sessions.map(async (session) => {
				const confirmedSlots = await SlotRequest.countDocuments({
					sessionId: session._id,
					status: "confirmed",
				});
				const waitlistCount = await SlotRequest.countDocuments({
					sessionId: session._id,
					status: "waitlisted",
				});
				return {
					title: session.title,
					sessionCode: session.sessionCode,
					hostUsername: session.hostUsername,
					status: session.status,
					maxSlots: session.maxSlots,
					confirmedSlots,
					waitlistCount,
				};
			}),
		);

		const leaderboard = await User.find({
			$or: [
				{ totalPresentations: { $gt: 0 } },
				{ totalSessionsAttended: { $gt: 0 } },
				{ totalFeedbackGiven: { $gt: 0 } },
			],
		})
			.sort({
				currentStreak: -1,
				totalPresentations: -1,
				totalSessionsAttended: -1,
				totalFeedbackGiven: -1,
			})
			.limit(10)
			.lean();

		const guild = await client.guilds.fetch(GUILD_ID, { withCounts: true });
		const totalMembers = guild.approximateMemberCount;

		res.json({
			stats: {
				upcomingSessions: enrichedSessions.length,
				totalPresentations: await Participation.countDocuments(),
				totalAttendance: await Attendance.countDocuments(),
				totalFeedback: await Feedback.countDocuments(),
				totalMembers,
			},
			sessions: enrichedSessions,
			leaderboard,
		});
	} catch (error) {
		console.error("Stats route error:", error);
		res.status(500).json({ error: "Failed to fetch stats" });
	}
});

/* ----------------------------- HELPERS ----------------------------- */

function hasRole(member, roles) {
	return member?.roles?.cache?.some((role) => roles.includes(role.name));
}

function hasHostAccess(member) {
	return hasRole(member, ["Admin", "Moderator", "Host"]);
}

function isAdminOrModerator(member) {
	return hasRole(member, ["Admin", "Moderator"]);
}

function canManageSession(interaction, session) {
	return (
		session.hostDiscordId === interaction.user.id ||
		isAdminOrModerator(interaction.member)
	);
}

function getWeekKey(date = new Date()) {
	const d = new Date(
		Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
	);
	const day = d.getUTCDay() || 7;
	d.setUTCDate(d.getUTCDate() + 4 - day);
	const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
	const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
	return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function getPreviousWeekKey(weekKey) {
	const [year, weekRaw] = weekKey.split("-W");
	let y = Number(year);
	let w = Number(weekRaw) - 1;

	if (w < 1) {
		y -= 1;
		w = 52;
	}

	return `${y}-W${String(w).padStart(2, "0")}`;
}

function parseUtcOffsetMinutes(tz) {
	if (!tz || tz.toUpperCase() === "UTC") return 0;

	const match = tz.match(/^UTC([+-])(\d{1,2})(?::?(\d{2}))?$/i);
	if (!match) return 0;

	const sign = match[1] === "+" ? 1 : -1;
	const hours = Number(match[2]);
	const minutes = Number(match[3] || 0);

	return sign * (hours * 60 + minutes);
}

function parseTimeParts(time) {
	const cleaned = String(time).trim().toLowerCase().replace(/\s+/g, "");
	const match = cleaned.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);

	if (!match) return null;

	let hour = Number(match[1]);
	const minute = Number(match[2] || 0);
	const meridiem = match[3];

	if (minute < 0 || minute > 59) return null;

	if (meridiem) {
		if (hour < 1 || hour > 12) return null;
		if (meridiem === "pm" && hour !== 12) hour += 12;
		if (meridiem === "am" && hour === 12) hour = 0;
	} else {
		if (hour < 0 || hour > 23) return null;
	}

	return { hour, minute };
}

function getNextDateForDay(day) {
	const today = new Date();
	const targetDay = dayMap[day];
	const currentDay = today.getDay();

	let diff = targetDay - currentDay;

	if (diff <= 0) diff += 7;

	const nextDate = new Date(today);
	nextDate.setDate(today.getDate() + diff);

	return nextDate;
}

function buildScheduledAt(day, time, timezone) {
	const base = getNextDateForDay(day);
	const parts = parseTimeParts(time);

	if (!parts) return null;

	const offsetMinutes = parseUtcOffsetMinutes(timezone);

	const utcMs = Date.UTC(
		base.getFullYear(),
		base.getMonth(),
		base.getDate(),
		parts.hour,
		parts.minute,
		0,
		0,
	);

	return new Date(utcMs - offsetMinutes * 60 * 1000);
}

function isWithinScheduleLimit(date) {
	const now = new Date();
	const limit = new Date(
		now.getTime() + Number(SCHEDULE_LIMIT_DAYS) * 24 * 60 * 60 * 1000,
	);

	return date <= limit;
}

function cleanTimeCode(time) {
	return time.toLowerCase().replace(/\s+/g, "").replace(/:/g, "");
}

function buildSessionCode(day, time) {
	const suffix = Math.random().toString(36).slice(2, 6);
	return `${shortDay[day]}-${cleanTimeCode(time)}-${suffix}`;
}

async function upsertUser(discordUser) {
	return User.findOneAndUpdate(
		{ discordId: discordUser.id },
		{ $set: { username: discordUser.username } },
		{ upsert: true, new: true },
	);
}

async function assignRole(guild, userId, roleName) {
	const member = await guild.members.fetch(userId).catch(() => null);
	if (!member) return false;

	const role = guild.roles.cache.find((r) => r.name === roleName);
	if (!role) return false;

	if (!member.roles.cache.has(role.id)) {
		await member.roles.add(role);
		return true;
	}

	return false;
}

async function assignProgressRoles(
	guild,
	userId,
	currentStreak,
	totalPresentations,
) {
	const added = [];

	if (totalPresentations >= 1) {
		if (await assignRole(guild, userId, "Presenter")) added.push("Presenter");
	}

	if (currentStreak >= 4) {
		if (await assignRole(guild, userId, "Consistent Builder"))
			added.push("Consistent Builder");
	}

	if (currentStreak >= 10) {
		if (await assignRole(guild, userId, "Demo Veteran"))
			added.push("Demo Veteran");
	}

	return added;
}

async function assignFeedbackRoles(guild, userId, totalFeedbackGiven) {
	const added = [];

	if (totalFeedbackGiven >= 3) {
		if (await assignRole(guild, userId, "Feedback Contributor"))
			added.push("Feedback Contributor");
	}

	if (totalFeedbackGiven >= 10) {
		if (await assignRole(guild, userId, "Trusted Reviewer"))
			added.push("Trusted Reviewer");
	}

	if (totalFeedbackGiven >= 25) {
		if (await assignRole(guild, userId, "Mentor Track"))
			added.push("Mentor Track");
	}

	return added;
}

async function assignAttendanceRoles(guild, userId, totalSessionsAttended) {
	const added = [];

	if (totalSessionsAttended >= 3) {
		if (await assignRole(guild, userId, "Regular Attendee"))
			added.push("Regular Attendee");
	}

	if (totalSessionsAttended >= 10) {
		if (await assignRole(guild, userId, "Community Regular"))
			added.push("Community Regular");
	}

	if (totalSessionsAttended >= 25) {
		if (await assignRole(guild, userId, "Core Member"))
			added.push("Core Member");
	}

	return added;
}

async function findSessionByCode(code) {
	return Session.findOne({ sessionCode: code.toLowerCase() });
}

async function findOverlap({ scheduledAt, endsAt, excludeId = null }) {
	const query = {
		status: { $in: ["scheduled", "live"] },
		scheduledAt: { $lt: endsAt },
		endsAt: { $gt: scheduledAt },
	};

	if (excludeId) query._id = { $ne: excludeId };

	return Session.findOne(query);
}

async function applyNoShowsForSession(session) {
	const confirmedSlots = await SlotRequest.find({
		sessionId: session._id,
		status: "confirmed",
	});

	const noShows = [];

	for (const slot of confirmedSlots) {
		const presented = await Participation.findOne({
			sessionId: session._id,
			discordId: slot.discordId,
		});

		if (presented) continue;

		slot.status = "no_show";
		slot.noShowAt = new Date();
		await slot.save();

		const user = await User.findOneAndUpdate(
			{ discordId: slot.discordId },
			{
				$set: { username: slot.username },
				$inc: { noShowCount: 1 },
			},
			{ upsert: true, new: true },
		);

		noShows.push({
			username: slot.username,
			noShowCount: user.noShowCount,
		});
	}

	return noShows;
}

async function createDiscordScheduledEvent(guild, session) {
	const event = await guild.scheduledEvents.create({
		name: session.title,
		scheduledStartTime: session.scheduledAt,
		scheduledEndTime: session.endsAt,
		privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
		entityType: GuildScheduledEventEntityType.External,
		entityMetadata: {
			location: "DemoLoop Discord voice session",
		},
		description: `Live DemoLoop practice session.

Session code: ${session.sessionCode}
Host: ${session.hostUsername}
Slots: ${session.maxSlots}
Timezone: ${session.timezone}

Use /request-slot to reserve a speaker slot.`,
	});

	return event.id;
}

async function updateDiscordScheduledEvent(guild, session) {
	if (!session.discordEventId) return;

	const event = await guild.scheduledEvents
		.fetch(session.discordEventId)
		.catch(() => null);

	if (!event) return;

	await event.edit({
		name: session.title,
		scheduledStartTime: session.scheduledAt,
		scheduledEndTime: session.endsAt,
		entityMetadata: {
			location: "DemoLoop Discord voice session",
		},
		description: `Live DemoLoop practice session.

Session code: ${session.sessionCode}
Host: ${session.hostUsername}
Slots: ${session.maxSlots}
Timezone: ${session.timezone}

Use /request-slot to reserve a speaker slot.`,
	});
}

async function deleteDiscordScheduledEvent(guild, session) {
	if (!session.discordEventId) return;

	const event = await guild.scheduledEvents
		.fetch(session.discordEventId)
		.catch(() => null);

	if (!event) return;

	await event.delete().catch(() => null);
}

async function countAttendanceIfEligible(guild, session, tracker) {
	if (tracker.counted) return;

	const requiredMs = Number(ATTENDANCE_MINUTES_REQUIRED) * 60 * 1000;

	if (tracker.cumulativeMs < requiredMs) return;

	const user = await User.findOneAndUpdate(
		{ discordId: tracker.discordId },
		{ $set: { username: tracker.username } },
		{ upsert: true, new: true },
	);

	try {
		await Attendance.create({
			sessionId: session._id,
			discordId: tracker.discordId,
			username: tracker.username,
			weekKey: session.weekKey,
			attendedAt: new Date(),
		});
	} catch {
		tracker.counted = true;
		await tracker.save();
		return;
	}

	const previousWeek = getPreviousWeekKey(session.weekKey);
	let newAttendanceStreak = 1;

	if (user.lastAttendedWeek === session.weekKey) {
		newAttendanceStreak = user.attendanceStreak;
	} else if (user.lastAttendedWeek === previousWeek) {
		newAttendanceStreak = user.attendanceStreak + 1;
	}

	user.totalSessionsAttended += 1;
	user.attendanceStreak = newAttendanceStreak;
	user.longestAttendanceStreak = Math.max(
		user.longestAttendanceStreak || 0,
		newAttendanceStreak,
	);
	user.lastAttendedWeek = session.weekKey;
	await user.save();

	tracker.counted = true;
	await tracker.save();

	await assignAttendanceRoles(
		guild,
		tracker.discordId,
		user.totalSessionsAttended,
	);
}

async function startTrackingVoiceMember(session, member) {
	if (!member || member.user.bot) return;

	await AttendanceTracker.findOneAndUpdate(
		{ sessionId: session._id, discordId: member.id },
		{
			$set: {
				username: member.user.username,
				joinedAt: new Date(),
			},
			$setOnInsert: {
				cumulativeMs: 0,
				counted: false,
			},
		},
		{ upsert: true, new: true },
	);
}

async function stopTrackingVoiceMember(guild, session, member) {
	if (!member || member.user.bot) return;

	const tracker = await AttendanceTracker.findOne({
		sessionId: session._id,
		discordId: member.id,
	});

	if (!tracker || !tracker.joinedAt) return;

	const now = new Date();
	const elapsed = now.getTime() - tracker.joinedAt.getTime();

	tracker.cumulativeMs += Math.max(elapsed, 0);
	tracker.joinedAt = null;
	await tracker.save();

	await countAttendanceIfEligible(guild, session, tracker);
}

/* ----------------------------- COMMANDS ----------------------------- */

const dayChoices = Object.keys(dayMap).map((day) => ({
	name: displayDay[day],
	value: day,
}));

const commands = [
	new SlashCommandBuilder()
		.setName("create-session")
		.setDescription("Create a DemoLoop session")
		.addStringOption((o) =>
			o
				.setName("day")
				.setDescription("Session day")
				.setRequired(true)
				.addChoices(...dayChoices),
		)
		.addStringOption((o) =>
			o
				.setName("time")
				.setDescription("Session time, e.g. 6PM")
				.setRequired(true),
		)
		.addIntegerOption((o) =>
			o
				.setName("duration_minutes")
				.setDescription("Duration in minutes")
				.setRequired(false),
		)
		.addIntegerOption((o) =>
			o
				.setName("max_slots")
				.setDescription("Maximum speaker slots")
				.setRequired(false),
		),

	new SlashCommandBuilder()
		.setName("sessions")
		.setDescription("Show upcoming DemoLoop sessions"),

	new SlashCommandBuilder()
		.setName("my-sessions")
		.setDescription("Show sessions you are hosting or presenting in"),

	new SlashCommandBuilder()
		.setName("request-slot")
		.setDescription("Request a speaker slot")
		.addStringOption((o) =>
			o
				.setName("session")
				.setDescription("Session code from /sessions")
				.setRequired(true),
		)
		.addStringOption((o) =>
			o.setName("title").setDescription("Presentation title").setRequired(true),
		)
		.addStringOption((o) =>
			o
				.setName("improve")
				.setDescription("What do you want to improve?")
				.setRequired(true),
		),

	new SlashCommandBuilder()
		.setName("leave-slot")
		.setDescription("Leave a speaker slot you reserved")
		.addStringOption((o) =>
			o.setName("session").setDescription("Session code").setRequired(true),
		),

	new SlashCommandBuilder()
		.setName("queue")
		.setDescription("View speaker queue")
		.addStringOption((o) =>
			o.setName("session").setDescription("Session code").setRequired(true),
		),

	new SlashCommandBuilder()
		.setName("start-session")
		.setDescription("Start a scheduled session")
		.addStringOption((o) =>
			o.setName("session").setDescription("Session code").setRequired(true),
		),

	new SlashCommandBuilder()
		.setName("end-session")
		.setDescription("End a live session")
		.addStringOption((o) =>
			o.setName("session").setDescription("Session code").setRequired(true),
		),

	new SlashCommandBuilder()
		.setName("reschedule-session")
		.setDescription("Reschedule a session time")
		.addStringOption((o) =>
			o.setName("session").setDescription("Session code").setRequired(true),
		)
		.addStringOption((o) =>
			o.setName("time").setDescription("New time, e.g. 8PM").setRequired(true),
		)
		.addIntegerOption((o) =>
			o
				.setName("duration_minutes")
				.setDescription("New duration in minutes")
				.setRequired(false),
		),

	new SlashCommandBuilder()
		.setName("cancel-session")
		.setDescription("Cancel a scheduled session")
		.addStringOption((o) =>
			o.setName("session").setDescription("Session code").setRequired(true),
		),

	new SlashCommandBuilder()
		.setName("presented")
		.setDescription("Mark a user as presented")
		.addStringOption((o) =>
			o.setName("session").setDescription("Session code").setRequired(true),
		)
		.addUserOption((o) =>
			o.setName("user").setDescription("Presenter").setRequired(true),
		),

	new SlashCommandBuilder()
		.setName("give-feedback")
		.setDescription("Give structured feedback")
		.addStringOption((o) =>
			o.setName("session").setDescription("Session code").setRequired(true),
		)
		.addUserOption((o) =>
			o.setName("speaker").setDescription("Presenter").setRequired(true),
		)
		.addIntegerOption((o) =>
			o
				.setName("clarity")
				.setDescription("Clarity 1-10")
				.setMinValue(1)
				.setMaxValue(10)
				.setRequired(true),
		)
		.addIntegerOption((o) =>
			o
				.setName("structure")
				.setDescription("Structure 1-10")
				.setMinValue(1)
				.setMaxValue(10)
				.setRequired(true),
		)
		.addIntegerOption((o) =>
			o
				.setName("delivery")
				.setDescription("Delivery 1-10")
				.setMinValue(1)
				.setMaxValue(10)
				.setRequired(true),
		)
		.addStringOption((o) =>
			o.setName("note").setDescription("Feedback note").setRequired(true),
		),

	new SlashCommandBuilder()
		.setName("host-interest")
		.setDescription("Submit interest to become a DemoLoop Host")
		.addStringOption((o) =>
			o
				.setName("day")
				.setDescription("Preferred hosting day")
				.setRequired(true)
				.addChoices(...dayChoices),
		)
		.addStringOption((o) =>
			o
				.setName("time")
				.setDescription("Preferred time, e.g. 6PM")
				.setRequired(true),
		)
		.addStringOption((o) =>
			o
				.setName("reason")
				.setDescription("Why do you want to host?")
				.setRequired(true),
		)
		.addStringOption((o) =>
			o
				.setName("experience")
				.setDescription("Relevant experience")
				.setRequired(true),
		),

	new SlashCommandBuilder()
		.setName("approve-host")
		.setDescription("Approve a member as a DemoLoop Host")
		.addUserOption((o) =>
			o
				.setName("user")
				.setDescription("User to approve as Host")
				.setRequired(true),
		),

	new SlashCommandBuilder()
		.setName("streak")
		.setDescription("Check stats")
		.addUserOption((o) =>
			o.setName("user").setDescription("Optional user").setRequired(false),
		),

	new SlashCommandBuilder()
		.setName("leaderboard")
		.setDescription("View leaderboard"),
].map((c) => c.toJSON());

async function registerCommands() {
	const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

	await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
		body: commands,
	});

	console.log("Slash commands registered.");
}

/* ----------------------------- EVENTS ----------------------------- */

client.once("clientReady", async () => {
	console.log(`Logged in as ${client.user.tag}`);
	await mongoose.connect(MONGODB_URI);
	console.log("Connected to MongoDB");
	await registerCommands();

	app.listen(PORT, () => {
		console.log(`Stats API running on port ${PORT}`);
	});
});

client.on("voiceStateUpdate", async (oldState, newState) => {
	try {
		const liveSessions = await Session.find({
			status: "live",
			voiceChannelId: { $exists: true, $ne: null },
		});

		for (const session of liveSessions) {
			const oldInSession = oldState.channelId === session.voiceChannelId;
			const newInSession = newState.channelId === session.voiceChannelId;

			if (!oldInSession && newInSession) {
				await startTrackingVoiceMember(session, newState.member);
			}

			if (oldInSession && !newInSession) {
				await stopTrackingVoiceMember(oldState.guild, session, oldState.member);
			}
		}
	} catch (error) {
		console.error("voiceStateUpdate error:", error);
	}
});

setInterval(async () => {
	try {
		const guild = await client.guilds.fetch(GUILD_ID);

		const liveSessions = await Session.find({
			status: "live",
			voiceChannelId: { $exists: true, $ne: null },
		});

		for (const session of liveSessions) {
			const channel = await guild.channels
				.fetch(session.voiceChannelId)
				.catch(() => null);

			if (!channel || !channel.members) continue;

			for (const [, member] of channel.members) {
				if (member.user.bot) continue;

				const tracker = await AttendanceTracker.findOne({
					sessionId: session._id,
					discordId: member.id,
				});

				if (!tracker || !tracker.joinedAt || tracker.counted) continue;

				const now = new Date();
				const liveElapsed = now.getTime() - tracker.joinedAt.getTime();
				const total = tracker.cumulativeMs + Math.max(liveElapsed, 0);

				if (total >= Number(ATTENDANCE_MINUTES_REQUIRED) * 60 * 1000) {
					tracker.cumulativeMs = total;
					await tracker.save();
					await countAttendanceIfEligible(guild, session, tracker);
				}
			}
		}
	} catch (error) {
		console.error("attendance interval error:", error);
	}
}, 60 * 1000);

client.on("interactionCreate", async (interaction) => {
	if (!interaction.isChatInputCommand()) return;

	try {
		const commandName = interaction.commandName;

		if (commandName === "create-session") {
			if (!hasHostAccess(interaction.member)) {
				return interaction.reply({
					content: "Only Admins, Moderators, or Hosts can create sessions.",
					ephemeral: true,
				});
			}

			const day = interaction.options.getString("day");
			const time = interaction.options.getString("time");
			const durationMinutes =
				interaction.options.getInteger("duration_minutes") ||
				Number(DEFAULT_SESSION_DURATION_MINUTES);
			const maxSlots =
				interaction.options.getInteger("max_slots") ||
				Number(MAX_SLOTS_PER_SESSION);

			const scheduledAt = buildScheduledAt(day, time, DEFAULT_TIMEZONE);

			if (!scheduledAt) {
				return interaction.reply({
					content:
						"Invalid time format. Use examples like 6PM, 9:30PM, or 18:00.",
					ephemeral: true,
				});
			}

			if (!isWithinScheduleLimit(scheduledAt)) {
				return interaction.reply({
					content: `Sessions can only be scheduled up to ${SCHEDULE_LIMIT_DAYS} days ahead.`,
					ephemeral: true,
				});
			}

			const endsAt = new Date(
				scheduledAt.getTime() + durationMinutes * 60 * 1000,
			);
			const weekKey = getWeekKey(scheduledAt);

			const existingCount = await Session.countDocuments({
				weekKey,
				status: { $ne: "cancelled" },
			});

			if (existingCount >= Number(MAX_SESSIONS_PER_WEEK)) {
				return interaction.reply({
					content: `This week already has the maximum allowed sessions: ${MAX_SESSIONS_PER_WEEK}.`,
					ephemeral: true,
				});
			}

			const overlap = await findOverlap({ scheduledAt, endsAt });

			if (overlap) {
				return interaction.reply({
					content: `This overlaps with an existing session: **${overlap.title}** (\`${overlap.sessionCode}\`).`,
					ephemeral: true,
				});
			}

			const sessionCode = buildSessionCode(day, time);
			const title = `DemoLoop ${displayDay[day]} • ${time}`;

			const session = await Session.create({
				sessionCode,
				title,
				day,
				time,
				timezone: DEFAULT_TIMEZONE,
				weekKey,
				scheduledAt,
				endsAt,
				durationMinutes,
				maxSlots,
				status: "scheduled",
				hostDiscordId: interaction.user.id,
				hostUsername: interaction.user.username,
			});

			try {
				session.discordEventId = await createDiscordScheduledEvent(
					interaction.guild,
					session,
				);
				await session.save();
			} catch (error) {
				console.error("Failed to create Discord scheduled event:", error);
			}

			return interaction.reply(
				`✅ **Session Created**\n\n**${session.title} (${
					session.timezone
				})**\nCode: \`${session.sessionCode}\`\nDuration: **${
					session.durationMinutes
				} mins**\nSlots: **${session.maxSlots}**\nWeek: **${session.weekKey}**${
					session.discordEventId
						? "\nDiscord Event: created"
						: "\nDiscord Event: failed to create"
				}`,
			);
		}

		if (commandName === "sessions") {
			const now = new Date();

			const sessions = await Session.find({
				status: { $in: ["scheduled", "live"] },
				endsAt: { $gte: now },
			})
				.sort({ scheduledAt: 1 })
				.limit(15);

			if (!sessions.length) {
				return interaction.reply(
					"No upcoming DemoLoop sessions scheduled yet.",
				);
			}

			const lines = [];

			for (const s of sessions) {
				const confirmedCount = await SlotRequest.countDocuments({
					sessionId: s._id,
					status: "confirmed",
				});

				const waitlistCount = await SlotRequest.countDocuments({
					sessionId: s._id,
					status: "waitlisted",
				});

				lines.push(
					`**${s.title} (${s.timezone})**\nCode: \`${s.sessionCode}\`\nHost: ${
						s.hostUsername
					}\nStatus: **${s.status}**\nDuration: **${
						s.durationMinutes
					} mins**\nSlots: **${confirmedCount}/${s.maxSlots}**${
						waitlistCount ? `\nWaitlist: **${waitlistCount}**` : ""
					}`,
				);
			}

			return interaction.reply(
				`📅 **Upcoming DemoLoop Sessions**\n\n${lines.join("\n\n")}`,
			);
		}

		if (commandName === "my-sessions") {
			const now = new Date();

			const hosting = await Session.find({
				hostDiscordId: interaction.user.id,
				status: { $in: ["scheduled", "live"] },
				endsAt: { $gte: now },
			}).sort({ scheduledAt: 1 });

			const slots = await SlotRequest.find({
				discordId: interaction.user.id,
				status: { $in: ["confirmed", "waitlisted"] },
			}).populate("sessionId");

			const upcomingSlots = slots.filter(
				(slot) =>
					slot.sessionId &&
					["scheduled", "live"].includes(slot.sessionId.status) &&
					slot.sessionId.endsAt >= now,
			);

			const hostingText = hosting.length
				? hosting.map((s) => `• ${s.title} — \`${s.sessionCode}\``).join("\n")
				: "None";

			const slotText = upcomingSlots.length
				? upcomingSlots
						.map(
							(slot) =>
								`• ${slot.sessionId.title} — \`${slot.sessionId.sessionCode}\` — ${slot.status}`,
						)
						.join("\n")
				: "None";

			return interaction.reply(
				`📌 **My DemoLoop Sessions**\n\n**Hosting:**\n${hostingText}\n\n**Speaking Slots:**\n${slotText}`,
			);
		}

		if (commandName === "request-slot") {
			const code = interaction.options.getString("session").toLowerCase();
			const session = await findSessionByCode(code);

			if (!session || ["cancelled", "ended"].includes(session.status)) {
				return interaction.reply({
					content: "Session not found or no longer available.",
					ephemeral: true,
				});
			}

			const dbUser = await upsertUser(interaction.user);

			if (dbUser.noShowCount >= Number(NO_SHOW_HOST_APPROVAL_THRESHOLD)) {
				return interaction.reply({
					content:
						"You have reached the no-show limit. A Host, Moderator, or Admin must approve your next speaker slot.",
					ephemeral: true,
				});
			}

			const confirmedCount = await SlotRequest.countDocuments({
				sessionId: session._id,
				status: "confirmed",
			});

			const title = interaction.options.getString("title");
			const improveGoal = interaction.options.getString("improve");

			let status = "confirmed";

			if (
				dbUser.noShowCount >= Number(NO_SHOW_WAITLIST_THRESHOLD) ||
				confirmedCount >= session.maxSlots
			) {
				status = "waitlisted";
			}

			try {
				await SlotRequest.create({
					sessionId: session._id,
					discordId: interaction.user.id,
					username: interaction.user.username,
					title,
					improveGoal,
					status,
				});
			} catch {
				return interaction.reply({
					content:
						"You already reserved or joined the waitlist for this session.",
					ephemeral: true,
				});
			}

			if (status === "waitlisted") {
				return interaction.reply(
					`🕒 **Added to Waitlist**\n\nSession: **${session.title}**\nSpeaker: ${interaction.user}\nTitle: **${title}**\nGoal: ${improveGoal}\n\nYou are waitlisted because the session is full or because of previous no-shows.`,
				);
			}

			return interaction.reply(
				`✅ **Speaker Slot Reserved**\n\nSession: **${
					session.title
				}**\nSpeaker: ${
					interaction.user
				}\nTitle: **${title}**\nGoal: ${improveGoal}\nSlot: **${
					confirmedCount + 1
				}/${session.maxSlots}**`,
			);
		}

		if (commandName === "leave-slot") {
			const code = interaction.options.getString("session").toLowerCase();
			const session = await findSessionByCode(code);

			if (!session || ["cancelled", "ended"].includes(session.status)) {
				return interaction.reply({
					content: "Session not found or no longer available.",
					ephemeral: true,
				});
			}

			const updated = await SlotRequest.findOneAndUpdate(
				{
					sessionId: session._id,
					discordId: interaction.user.id,
					status: { $in: ["confirmed", "waitlisted"] },
				},
				{
					$set: {
						status: "left",
						leftAt: new Date(),
					},
				},
				{ new: true },
			);

			if (!updated) {
				return interaction.reply({
					content: "You do not have an active speaker slot for this session.",
					ephemeral: true,
				});
			}

			return interaction.reply(
				`✅ You left your speaker slot for **${session.title}**. No no-show penalty will be applied.`,
			);
		}

		if (commandName === "queue") {
			const code = interaction.options.getString("session").toLowerCase();
			const session = await findSessionByCode(code);

			if (!session) {
				return interaction.reply({
					content: "Session not found.",
					ephemeral: true,
				});
			}

			const queue = await SlotRequest.find({
				sessionId: session._id,
				status: { $in: ["confirmed", "waitlisted"] },
			}).sort({ status: 1, createdAt: 1 });

			if (!queue.length) {
				return interaction.reply("No active speaker slots reserved yet.");
			}

			const text = queue
				.map(
					(q, i) =>
						`**${i + 1}. ${q.username}** ${
							q.status === "waitlisted" ? "— waitlisted" : ""
						}\nTitle: ${q.title}\nGoal: ${q.improveGoal}`,
				)
				.join("\n\n");

			return interaction.reply(`🎤 **Queue — ${session.title}**\n\n${text}`);
		}

		if (commandName === "start-session") {
			if (!hasHostAccess(interaction.member)) {
				return interaction.reply({
					content: "Only Admins, Moderators, or Hosts can start sessions.",
					ephemeral: true,
				});
			}

			const code = interaction.options.getString("session").toLowerCase();
			const session = await findSessionByCode(code);

			if (!session || session.status !== "scheduled") {
				return interaction.reply({
					content: "Session not found or cannot be started.",
					ephemeral: true,
				});
			}

			if (!canManageSession(interaction, session)) {
				return interaction.reply({
					content:
						"Only the session host, Admin, or Moderator can start this session.",
					ephemeral: true,
				});
			}

			const voiceChannel = interaction.member.voice?.channel;

			if (!voiceChannel) {
				return interaction.reply({
					content:
						"Join the voice/stage channel first, then run `/start-session`.",
					ephemeral: true,
				});
			}

			session.status = "live";
			session.startedAt = new Date();
			session.voiceChannelId = voiceChannel.id;
			await session.save();

			for (const [, member] of voiceChannel.members) {
				await startTrackingVoiceMember(session, member);
			}

			return interaction.reply(
				`🎤 **Session Live**\n\n**${session.title}**\nCode: \`${session.sessionCode}\`\nRoom: **${voiceChannel.name}**\n\nAttendance is tracked automatically after **${ATTENDANCE_MINUTES_REQUIRED} minutes**.`,
			);
		}

		if (commandName === "end-session") {
			if (!hasHostAccess(interaction.member)) {
				return interaction.reply({
					content: "Only Admins, Moderators, or Hosts can end sessions.",
					ephemeral: true,
				});
			}

			const code = interaction.options.getString("session").toLowerCase();
			const session = await findSessionByCode(code);

			if (!session || session.status !== "live") {
				return interaction.reply({
					content: "Session not found or not live.",
					ephemeral: true,
				});
			}

			if (!canManageSession(interaction, session)) {
				return interaction.reply({
					content:
						"Only the session host, Admin, or Moderator can end this session.",
					ephemeral: true,
				});
			}

			const guild = interaction.guild;
			const channel = await guild.channels
				.fetch(session.voiceChannelId)
				.catch(() => null);

			if (channel?.members) {
				for (const [, member] of channel.members) {
					await stopTrackingVoiceMember(guild, session, member);
				}
			}

			session.status = "ended";
			session.endedAt = new Date();
			await session.save();

			const noShows = await applyNoShowsForSession(session);

			const presenters = await Participation.find({
				sessionId: session._id,
			}).sort({ presentedAt: 1 });

			const attendees = await Attendance.countDocuments({
				sessionId: session._id,
			});

			const presenterText = presenters.length
				? presenters.map((p) => `• ${p.username}`).join("\n")
				: "No presenters recorded.";

			const noShowText = noShows.length
				? noShows
						.map((n) => `• ${n.username} — ${n.noShowCount} no-show(s)`)
						.join("\n")
				: "No no-shows.";

			return interaction.reply(
				`🎉 **Session Ended**\n\n**${session.title}**\n\nPresenters:\n${presenterText}\n\nAttendance counted: **${attendees}**\n\nNo-shows:\n${noShowText}`,
			);
		}

		if (commandName === "reschedule-session") {
			if (!hasHostAccess(interaction.member)) {
				return interaction.reply({
					content: "Only Admins, Moderators, or Hosts can reschedule sessions.",
					ephemeral: true,
				});
			}

			const code = interaction.options.getString("session").toLowerCase();
			const newTime = interaction.options.getString("time");
			const session = await findSessionByCode(code);

			if (!session || session.status !== "scheduled") {
				return interaction.reply({
					content: "Only scheduled sessions can be rescheduled.",
					ephemeral: true,
				});
			}

			if (!canManageSession(interaction, session)) {
				return interaction.reply({
					content:
						"Only the session host, Admin, or Moderator can reschedule this session.",
					ephemeral: true,
				});
			}

			const newDuration =
				interaction.options.getInteger("duration_minutes") ||
				session.durationMinutes ||
				Number(DEFAULT_SESSION_DURATION_MINUTES);

			const scheduledAt = buildScheduledAt(
				session.day,
				newTime,
				session.timezone,
			);

			if (!scheduledAt) {
				return interaction.reply({
					content:
						"Invalid time format. Use examples like 6PM, 9:30PM, or 18:00.",
					ephemeral: true,
				});
			}

			if (!isWithinScheduleLimit(scheduledAt)) {
				return interaction.reply({
					content: `Sessions can only be scheduled up to ${SCHEDULE_LIMIT_DAYS} days ahead.`,
					ephemeral: true,
				});
			}

			const endsAt = new Date(scheduledAt.getTime() + newDuration * 60 * 1000);

			const overlap = await findOverlap({
				scheduledAt,
				endsAt,
				excludeId: session._id,
			});

			if (overlap) {
				return interaction.reply({
					content: `This reschedule overlaps with an existing session: **${overlap.title}** (\`${overlap.sessionCode}\`).`,
					ephemeral: true,
				});
			}

			session.time = newTime;
			session.title = `DemoLoop ${displayDay[session.day]} • ${newTime}`;
			session.sessionCode = buildSessionCode(session.day, newTime);
			session.scheduledAt = scheduledAt;
			session.endsAt = endsAt;
			session.durationMinutes = newDuration;
			session.weekKey = getWeekKey(scheduledAt);
			await session.save();

			await updateDiscordScheduledEvent(interaction.guild, session).catch(
				(error) => {
					console.error("Failed to update Discord scheduled event:", error);
				},
			);

			return interaction.reply(
				`✅ **Session Rescheduled**\n\n${session.title}\nNew Code: \`${session.sessionCode}\`\nDuration: **${session.durationMinutes} mins**`,
			);
		}

		if (commandName === "cancel-session") {
			if (!hasHostAccess(interaction.member)) {
				return interaction.reply({
					content: "Only Admins, Moderators, or Hosts can cancel sessions.",
					ephemeral: true,
				});
			}

			const code = interaction.options.getString("session").toLowerCase();
			const session = await findSessionByCode(code);

			if (!session || !["scheduled", "live"].includes(session.status)) {
				return interaction.reply({
					content: "Session not found or cannot be cancelled.",
					ephemeral: true,
				});
			}

			if (!canManageSession(interaction, session)) {
				return interaction.reply({
					content:
						"Only the session host, Admin, or Moderator can cancel this session.",
					ephemeral: true,
				});
			}

			await deleteDiscordScheduledEvent(interaction.guild, session);

			session.status = "cancelled";
			session.cancelledAt = new Date();
			await session.save();

			await SlotRequest.updateMany(
				{
					sessionId: session._id,
					status: { $in: ["confirmed", "waitlisted"] },
				},
				{
					$set: {
						status: "left",
						leftAt: new Date(),
					},
				},
			);

			return interaction.reply(
				`❌ **Session Cancelled**\n\n${session.title}\nSpeaker queue cleared.`,
			);
		}

		if (commandName === "presented") {
			if (!hasHostAccess(interaction.member)) {
				return interaction.reply({
					content: "Only Admins, Moderators, or Hosts can mark presenters.",
					ephemeral: true,
				});
			}

			const code = interaction.options.getString("session").toLowerCase();
			const session = await findSessionByCode(code);

			if (!session || session.status !== "live") {
				return interaction.reply({
					content: "Session must be live before marking presenters.",
					ephemeral: true,
				});
			}

			if (!canManageSession(interaction, session)) {
				return interaction.reply({
					content:
						"Only the session host, Admin, or Moderator can manage presenters for this session.",
					ephemeral: true,
				});
			}

			const user = interaction.options.getUser("user");
			const dbUser = await upsertUser(user);

			const already = await Participation.findOne({
				sessionId: session._id,
				discordId: user.id,
			});

			if (already) {
				return interaction.reply({
					content: `${user} already marked as presented.`,
					ephemeral: true,
				});
			}

			await Participation.create({
				sessionId: session._id,
				discordId: user.id,
				username: user.username,
				presentedAt: new Date(),
				weekKey: session.weekKey,
			});

			const previousWeek = getPreviousWeekKey(session.weekKey);

			let newStreak = 1;

			if (dbUser.lastPresentedWeek === session.weekKey) {
				newStreak = dbUser.currentStreak;
			} else if (dbUser.lastPresentedWeek === previousWeek) {
				newStreak = dbUser.currentStreak + 1;
			}

			dbUser.currentStreak = newStreak;
			dbUser.longestStreak = Math.max(dbUser.longestStreak || 0, newStreak);
			dbUser.totalPresentations += 1;
			dbUser.lastPresentedWeek = session.weekKey;
			await dbUser.save();

			const roles = await assignProgressRoles(
				interaction.guild,
				user.id,
				dbUser.currentStreak,
				dbUser.totalPresentations,
			);

			return interaction.reply(
				`✅ ${user} marked as presented.\n\n🔥 Current streak: **${
					dbUser.currentStreak
				} week${dbUser.currentStreak === 1 ? "" : "s"}**${
					roles.length ? `\nUnlocked role(s): ${roles.join(", ")}` : ""
				}`,
			);
		}

		if (commandName === "give-feedback") {
			const code = interaction.options.getString("session").toLowerCase();
			const session = await findSessionByCode(code);

			if (!session || session.status !== "live") {
				return interaction.reply({
					content: "Feedback can only be submitted during a live session.",
					ephemeral: true,
				});
			}

			const speaker = interaction.options.getUser("speaker");

			if (speaker.id === interaction.user.id) {
				return interaction.reply({
					content: "You cannot give feedback to yourself.",
					ephemeral: true,
				});
			}

			const presented = await Participation.findOne({
				sessionId: session._id,
				discordId: speaker.id,
			});

			if (!presented) {
				return interaction.reply({
					content: "This speaker has not been marked as presented yet.",
					ephemeral: true,
				});
			}

			const giver = await upsertUser(interaction.user);

			try {
				await Feedback.create({
					sessionId: session._id,
					speakerDiscordId: speaker.id,
					speakerUsername: speaker.username,
					giverDiscordId: interaction.user.id,
					giverUsername: interaction.user.username,
					clarity: interaction.options.getInteger("clarity"),
					structure: interaction.options.getInteger("structure"),
					delivery: interaction.options.getInteger("delivery"),
					note: interaction.options.getString("note"),
				});
			} catch {
				return interaction.reply({
					content:
						"You already gave feedback to this speaker for this session.",
					ephemeral: true,
				});
			}

			giver.totalFeedbackGiven += 1;
			await giver.save();

			const roles = await assignFeedbackRoles(
				interaction.guild,
				interaction.user.id,
				giver.totalFeedbackGiven,
			);

			return interaction.reply(
				`✅ Feedback submitted for ${speaker}.\n\nFeedback given: **${
					giver.totalFeedbackGiven
				}**${roles.length ? `\nUnlocked role(s): ${roles.join(", ")}` : ""}`,
			);
		}

		if (commandName === "host-interest") {
			const day = interaction.options.getString("day");
			const time = interaction.options.getString("time");
			const reason = interaction.options.getString("reason");
			const experience = interaction.options.getString("experience");

			await upsertUser(interaction.user);

			try {
				await HostInterest.create({
					discordId: interaction.user.id,
					username: interaction.user.username,
					day,
					time,
					reason,
					experience,
					status: "pending",
				});
			} catch {
				return interaction.reply({
					content: "You already submitted host interest for that day and time.",
					ephemeral: true,
				});
			}

			return interaction.reply(
				`✅ **Host Interest Submitted**\n\nPreferred slot: **${displayDay[day]} • ${time} (${DEFAULT_TIMEZONE})**\nAdmins will review your request.`,
			);
		}

		if (commandName === "approve-host") {
			if (!isAdminOrModerator(interaction.member)) {
				return interaction.reply({
					content: "Only Admins or Moderators can approve hosts.",
					ephemeral: true,
				});
			}

			const user = interaction.options.getUser("user");

			const pending = await HostInterest.findOne({
				discordId: user.id,
				status: "pending",
			}).sort({ createdAt: -1 });

			if (!pending) {
				return interaction.reply({
					content: "No pending host interest found for this user.",
					ephemeral: true,
				});
			}

			pending.status = "approved";
			pending.reviewedByDiscordId = interaction.user.id;
			pending.reviewedByUsername = interaction.user.username;
			pending.reviewedAt = new Date();
			await pending.save();

			await upsertUser(user);
			const assigned = await assignRole(interaction.guild, user.id, "Host");

			return interaction.reply(
				`✅ ${user} approved as a DemoLoop Host.${
					assigned ? "\nHost role assigned." : ""
				}`,
			);
		}

		if (commandName === "streak") {
			const target = interaction.options.getUser("user") || interaction.user;
			const dbUser = await upsertUser(target);

			return interaction.reply(
				`🔥 **${target.username}'s DemoLoop Stats**\n\nPresentation streak: **${dbUser.currentStreak}**\nLongest presentation streak: **${dbUser.longestStreak}**\nTotal presentations: **${dbUser.totalPresentations}**\n\nAttendance streak: **${dbUser.attendanceStreak}**\nLongest attendance streak: **${dbUser.longestAttendanceStreak}**\nSessions attended: **${dbUser.totalSessionsAttended}**\n\nFeedback given: **${dbUser.totalFeedbackGiven}**\nNo-shows: **${dbUser.noShowCount}**`,
			);
		}

		if (commandName === "leaderboard") {
			const leaders = await User.find({
				$or: [
					{ totalPresentations: { $gt: 0 } },
					{ totalSessionsAttended: { $gt: 0 } },
					{ totalFeedbackGiven: { $gt: 0 } },
				],
			})
				.sort({
					currentStreak: -1,
					totalPresentations: -1,
					totalSessionsAttended: -1,
					totalFeedbackGiven: -1,
				})
				.limit(10);

			if (!leaders.length) {
				return interaction.reply("No activity recorded yet.");
			}

			const text = leaders
				.map(
					(u, i) =>
						`**${i + 1}. ${u.username}** — 🔥 ${
							u.currentStreak
						} presentation streak | 🎧 ${
							u.totalSessionsAttended
						} attended | 💬 ${u.totalFeedbackGiven} feedback | ⚠️ ${
							u.noShowCount || 0
						} no-shows`,
				)
				.join("\n");

			return interaction.reply(`🏆 **DemoLoop Leaderboard**\n\n${text}`);
		}
	} catch (error) {
		console.error(error);
		return interaction
			.reply({ content: "Something went wrong.", ephemeral: true })
			.catch(() => {});
	}
});

client.login(DISCORD_TOKEN);
