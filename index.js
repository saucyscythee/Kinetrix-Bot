const { 
    Client, 
    GatewayIntentBits, 
    SlashCommandBuilder, 
    REST, 
    Routes, 
    ActionRowBuilder, 
    StringSelectMenuBuilder 
} = require('discord.js');
const express = require('express');
require('dotenv').config();

// Web server setup to keep bot alive on Render
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Kinetrix Bot is online!'));
app.listen(PORT, () => console.log(`Keep-alive server listening on port ${PORT}`));

// Discord client setup (GuildMembers intent required for display names)
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

// Queue state stores user ID -> { joinedAt: number, channelId: string }
// channelId is the channel the player joined from, used for timeout notifications
const queues = {
    '4mans': new Map(),
    '6mans': new Map()
};

// Active drafts stored in memory: channelId -> draftState object
const activeDrafts = new Map();

// Target Server ID for instant Guild Command registration
const GUILD_ID = '1400141445985472542';

// Command Definitions
const commands = [
    new SlashCommandBuilder()
        .setName('4mans')
        .setDescription('Join the 2v2 queue (4 players needed)'),
    new SlashCommandBuilder()
        .setName('6mans')
        .setDescription('Join the 3v3 queue (6 players needed)'),
    new SlashCommandBuilder()
        .setName('leave')
        .setDescription('Leave any active queue'),
    new SlashCommandBuilder()
        .setName('status')
        .setDescription('View current queue status and players')
].map(command => command.toJSON());

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('Refreshing guild (/) commands...');
        await rest.put(
            Routes.applicationGuildCommands(client.user.id, GUILD_ID),
            { body: commands },
        );
        console.log('Successfully reloaded guild (/) commands instantly!');
    } catch (error) {
        console.error('Error loading slash commands:', error);
    }

    // Check for 1-hour queue timeouts every minute
    setInterval(checkQueueTimeouts, 60 * 1000);
});

client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        const { commandName, user, channelId, guild } = interaction;
        const userId = user.id;

        try {
            // Handle Queue Commands (/4mans & /6mans)
            if (commandName === '4mans' || commandName === '6mans') {
                const mode = commandName;
                const targetQueue = queues[mode];
                const targetSize = mode === '4mans' ? 4 : 6;

                for (const [m, q] of Object.entries(queues)) {
                    if (q.has(userId)) {
                        return interaction.reply({ 
                            content: `❌ You are already in the **/${m}** queue! Leave it first using \`/leave\`.`, 
                            flags: 64 
                        });
                    }
                }

                for (const draft of activeDrafts.values()) {
                    if ([draft.captain1, draft.captain2, ...draft.team1, ...draft.team2, ...draft.pool].includes(userId)) {
                        return interaction.reply({
                            content: `❌ You are currently in an active lobby draft!`,
                            flags: 64
                        });
                    }
                }

                // Defer reply immediately to prevent Discord 3-second timeouts on Render
                await interaction.deferReply();

                // Save join time AND the channel they joined from (for timeout notifications)
                targetQueue.set(userId, { joinedAt: Date.now(), channelId });
                const currentCount = targetQueue.size;

                if (currentCount === targetSize) {
                    const playerIds = Array.from(targetQueue.keys());
                    targetQueue.clear();

                    // Shuffle players
                    for (let i = playerIds.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [playerIds[i], playerIds[j]] = [playerIds[j], playerIds[i]];
                    }

                    // 2v2: random teams, no captains or draft
                    if (mode === '4mans') {
                        const team1 = playerIds.slice(0, 2);
                        const team2 = playerIds.slice(2, 4);
                        const allPings = playerIds.map(id => `<@${id}>`).join(' ');

                        return interaction.editReply({
                            content: `🚨 **/4MANS QUEUE POPPED!** 🚨\n${allPings}\n\n` +
                                `🎲 **Teams have been randomized!**\n\n` +
                                `🔵 **Blue Team:** ${team1.map(id => `<@${id}>`).join(', ')}\n` +
                                `🟠 **Orange Team:** ${team2.map(id => `<@${id}>`).join(', ')}\n\n` +
                                `*Get into voice channels and play!*`
                        });
                    }

                    // 3v3: captains + draft
                    const cap1 = playerIds[0];
                    const cap2 = playerIds[1];
                    const poolIds = playerIds.slice(2);

                    // Fetch member display names for dropdown menu
                    const memberMap = new Map();
                    for (const id of playerIds) {
                        try {
                            const member = await guild.members.fetch(id);
                            memberMap.set(id, member.displayName);
                        } catch {
                            memberMap.set(id, `Player ${id.slice(-4)}`);
                        }
                    }

                    const draftState = {
                        mode,
                        channelId: interaction.channelId,
                        captain1: cap1,
                        captain2: cap2,
                        team1: [cap1],
                        team2: [cap2],
                        pool: poolIds,
                        memberNames: memberMap,
                        step: 0,
                        turnCaptain: cap1
                    };

                    activeDrafts.set(interaction.channelId, draftState);

                    // Ping every player in the lobby when queue pops
                    const allPings = playerIds.map(id => `<@${id}>`).join(' ');

                    const initialMsg = `🚨 **/${mode.toUpperCase()} QUEUE POPPED!** 🚨\n${allPings}\n\n` +
                        `👑 **Captains Chosen:** <@${cap1}> (Team 1) vs <@${cap2}> (Team 2)\n\n` +
                        `📋 **Drafting Phase (1-2-1 Order):**\n` +
                        getDraftStatus(draftState);

                    const row = getDraftComponent(draftState);

                    return interaction.editReply({
                        content: initialMsg,
                        components: row ? [row] : []
                    });
                } else {
                    const needed = targetSize - currentCount;
                    return interaction.editReply({
                        content: `✅ <@${userId}> joined the **/${mode}** queue! (${currentCount}/${targetSize})\n*Need ${needed} more player(s) to pop.*`
                    });
                }
            } 
            
            // Handle Leave Command
            else if (commandName === 'leave') {
                let leftQueueName = null;
                let remainingCount = 0;
                let targetSize = 0;

                for (const [m, q] of Object.entries(queues)) {
                    if (q.has(userId)) {
                        q.delete(userId);
                        leftQueueName = m;
                        remainingCount = q.size;
                        targetSize = m === '4mans' ? 4 : 6;
                        break;
                    }
                }

                if (leftQueueName) {
                    return interaction.reply({
                        content: `🚪 <@${userId}> left the **/${leftQueueName}** queue. (${remainingCount}/${targetSize})`
                    });
                } else {
                    return interaction.reply({
                        content: `⚠️ You are not currently in any active queue.`,
                        flags: 64
                    });
                }
            }

            // Handle Status Command
            else if (commandName === 'status') {
                await interaction.deferReply();

                const formatQueue = (queueName, sizeLimit) => {
                    const q = queues[queueName];
                    if (q.size === 0) return `*Empty*`;
                    const list = Array.from(q.keys()).map(id => `<@${id}>`).join(', ');
                    return `${list} (${q.size}/${sizeLimit})`;
                };

                const draft = activeDrafts.get(interaction.channelId);
                let draftStatusText = `*No active draft in this channel.*`;
                if (draft) {
                    draftStatusText = `**/${draft.mode.toUpperCase()} Draft in Progress**\n` +
                        `Current Turn: <@${draft.turnCaptain}>\n` +
                        `Pool Remaining: ${draft.pool.length} player(s)`;
                }

                const statusEmbed = `📊 **CURRENT QUEUE STATUS** 📊\n\n` +
                    `🎮 **2v2 (/4mans):**\n${formatQueue('4mans', 4)}\n\n` +
                    `⚔️ **3v3 (/6mans):**\n${formatQueue('6mans', 6)}\n\n` +
                    `📋 **Active Draft Status:**\n${draftStatusText}`;

                return interaction.editReply({
                    content: statusEmbed
                });
            }
        } catch (error) {
            console.error(`Error executing command ${commandName}:`, error);
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({ content: 'An unexpected error occurred while executing this command.' });
                } else {
                    await interaction.reply({ content: 'An unexpected error occurred while executing this command.', flags: 64 });
                }
            } catch (subErr) {
                console.error('Failed to send error reply:', subErr);
            }
        }
    } 
    
    // Handle Dropdown Menu Selection Picks
    else if (interaction.isStringSelectMenu() && interaction.customId === 'draft_pick') {
        try {
            const draft = activeDrafts.get(interaction.channelId);
            if (!draft) {
                return interaction.reply({ content: `⚠️ No active draft found in this channel.`, flags: 64 });
            }

            if (interaction.user.id !== draft.turnCaptain) {
                return interaction.reply({ content: `❌ It is not your turn to pick!`, flags: 64 });
            }

            const pickedId = interaction.values[0];
            
            draft.pool = draft.pool.filter(id => id !== pickedId);
            if (draft.turnCaptain === draft.captain1) {
                draft.team1.push(pickedId);
            } else {
                draft.team2.push(pickedId);
            }

            advanceDraftTurn(draft);

            if (draft.pool.length === 0) {
                activeDrafts.delete(interaction.channelId);
                const finalSummary = `🏁 **DRAFT COMPLETE! MATCH READY!** 🏁\n\n` +
                    `🔵 **Blue Team (<@${draft.captain1}>):** ${draft.team1.map(id => `<@${id}>`).join(', ')}\n` +
                    `🟠 **Orange Team (<@${draft.captain2}>):** ${draft.team2.map(id => `<@${id}>`).join(', ')}\n\n` +
                    `*Get into voice channels and play!*`;

                return interaction.update({
                    content: finalSummary,
                    components: []
                });
            } else {
                const updatedMsg = `🚨 **/${draft.mode.toUpperCase()} DRAFT IN PROGRESS** 🚨\n\n` +
                    `👑 **Blue Team:** ${draft.team1.map(id => `<@${id}>`).join(', ')}\n` +
                    `👑 **Orange Team:** ${draft.team2.map(id => `<@${id}>`).join(', ')}\n\n` +
                    getDraftStatus(draft);

                return interaction.update({
                    content: updatedMsg,
                    components: [getDraftComponent(draft)]
                });
            }
        } catch (error) {
            console.error('Error handling draft selection:', error);
        }
    }
});

// Draft helper logic
function advanceDraftTurn(draft) {
    if (draft.mode === '4mans') {
        if (draft.pool.length === 1 && draft.turnCaptain === draft.captain1) {
            draft.team2.push(draft.pool[0]);
            draft.pool = [];
        }
    } else if (draft.mode === '6mans') {
        draft.step++;
        if (draft.step === 1) {
            draft.turnCaptain = draft.captain2;
        } else if (draft.step === 3) {
            draft.turnCaptain = draft.captain1;
        } else if (draft.step === 4 && draft.pool.length === 1) {
            draft.team1.push(draft.pool[0]);
            draft.pool = [];
        }
    }
}

function getDraftStatus(draft) {
    return `👉 **Current Turn:** <@${draft.turnCaptain}>\n` +
           `📋 **Available Pool:** ${draft.pool.map(id => `<@${id}>`).join(', ')}`;
}

function getDraftComponent(draft) {
    if (draft.pool.length === 0) return null;

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('draft_pick')
        .setPlaceholder('Select player to draft...')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
            draft.pool.map(id => ({
                label: draft.memberNames.get(id) || `Player ${id.slice(-4)}`,
                description: `Draft this player`,
                value: id
            }))
        );

    return new ActionRowBuilder().addComponents(selectMenu);
}

// 1-hour inactivity timeout checker (announces in the channel the player joined from)
async function checkQueueTimeouts() {
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const now = Date.now();

    for (const [mode, q] of Object.entries(queues)) {
        const targetSize = mode === '4mans' ? 4 : 6;

        // Collect expired players first, then remove them
        const expired = [];
        for (const [userId, entry] of q.entries()) {
            if (now - entry.joinedAt >= ONE_HOUR_MS) {
                expired.push([userId, entry]);
            }
        }
        for (const [userId] of expired) {
            q.delete(userId);
        }

        for (const [userId, entry] of expired) {
            const remainingCount = q.size;

            // Announce in the channel they queued from (pings the player)
            try {
                const channel = await client.channels.fetch(entry.channelId);
                await channel.send(
                    `⏰ <@${userId}>, you have been automatically removed from the **/${mode}** queue due to 1 hour of inactivity. ` +
                    `There are still **${remainingCount}** player(s) remaining in the queue (${remainingCount}/${targetSize}).`
                );
            } catch (err) {
                console.error('Failed to send timeout notification:', err);
            }
        }
    }
}

client.login(process.env.DISCORD_TOKEN);