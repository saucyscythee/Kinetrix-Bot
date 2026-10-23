require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

// 1. Keep-Alive Express Server for Render
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Kinetrix Bot is alive and running!');
});

app.listen(PORT, () => {
    console.log(`Keep-alive server listening on port ${PORT}`);
});

// 2. Initialize Discord Client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// Define Slash Commands
const commands = [
    new SlashCommandBuilder()
        .setName('status')
        .setDescription('Checks the live status of the Kinetrix matchmaking bot.'),
    new SlashCommandBuilder()
        .setName('4mans')
        .setDescription('Join or manage the 4-man queue (2v2).'),
    new SlashCommandBuilder()
        .setName('6mans')
        .setDescription('Join or manage the 6-man queue (3v3).'),
].map(command => command.toJSON());

// Register Slash Commands with Discord API on Ready
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
});

// 3. Robust Interaction Handler with Error Protection & Deferral
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    try {
        if (commandName === 'status') {
            // Defer reply immediately to prevent Discord's 3-second timeout / "application did not respond" error
            await interaction.deferReply();
            
            // Optional short delay for simulated processing
            await new Promise(resolve => setTimeout(resolve, 300));

            // Edit the deferred response with actual status data
            await interaction.editReply({
                content: `🟢 **Kinetrix Bot Status:** Online and operational!\n☁️ **Host:** Render Cloud (24/7 Uptime)`
            });
        } 
        else if (commandName === '4mans') {
            await interaction.reply({ content: 'Queue system for 4-mans (2v2) is initializing...', ephemeral: true });
        }
        else if (commandName === '6mans') {
            await interaction.reply({ content: 'Queue system for 6-mans (3v3) is initializing...', ephemeral: true });
        }
    } catch (error) {
        console.error(`Error handling command ${commandName}:`, error);
        
        // Fallback error response if interaction fails halfway
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ content: 'An error occurred while executing this command.' });
            } else {
                await interaction.reply({ content: 'An error occurred while executing this command.', ephemeral: true });
            }
        } catch (subError) {
            console.error('Failed to send error response:', subError);
        }
    }
});

// Log in the bot using the token stored in environment variables
client.login(process.env.DISCORD_TOKEN);