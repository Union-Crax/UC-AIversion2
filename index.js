// Load env
import 'dotenv/config';
import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import axios from 'axios';
import { testConnection, initializeDatabase, closeDatabase } from './database.js';
import { testEmbeddingService } from './embeddings.js';
import semanticContextManager from './context-manager.js';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;
const LOCAL = process.env.LOCAL === 'true';
const AI_MODEL = process.env.AI_MODEL;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const RANDOM_RESPONSE_CHANCE = parseFloat(process.env.RANDOM_RESPONSE_CHANCE || '0.1');
const PROMPT = process.env.PROMPT || '';
const DEBUG = process.env.DEBUG === 'true';
const ENABLE_MENTIONS = process.env.ENABLE_MENTIONS === 'true';
const ENABLE_SEMANTIC_SEARCH = process.env.ENABLE_SEMANTIC_SEARCH === 'true';
const ENABLE_DATABASE = process.env.ENABLE_DATABASE === 'true';
const FRIENDLY_FIRE = process.env.FRIENDLY_FIRE === 'true';

const START_TIME = Date.now();
let lastResponseTime = 0;
let isSemanticMode = false;

// === Init Discord Client ===
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
    ]
});

async function generateAMResponse(userInput, channelId, guildId, discordMessageId, authorId, authorName) {
    try {
        let contextText = '';
        
        if (isSemanticMode && semanticContextManager.isReady()) {
            const relevantContext = await semanticContextManager.getRelevantContext(userInput, guildId, authorId);
            
            relevantContext.slice(-10).forEach((msg, i) => {
                const speaker = msg.type === 'assistant' ? 'AM' : msg.author;
                const similarity = msg.similarity ? ` (relevance: ${(msg.similarity * 100).toFixed(1)}%)` : '';
                contextText += `${speaker}: ${msg.content}${similarity}\n`;
            });
            
            if (DEBUG) {
                console.log(` Used semantic context: ${relevantContext.length} relevant messages`);
            }
        } else {
            // Fallback to simple recent messages from cache
            contextText = '';
        }

        const promptText = `${PROMPT}\n\n${contextText}Human: ${userInput}\nAM:`;

        let reply = '';

        if (LOCAL) {
            throw new Error('Local model not supported in Node.js version.');
        } else {
            // OpenRouter API
            const response = await axios.post(
                'https://openrouter.ai/api/v1/chat/completions',
                {
                    model: AI_MODEL,
                    messages: [
                        { role: 'system', content: PROMPT },
                        { role: 'user', content: `${promptText}\nKeep your response under 3 sentences.` }
                    ],
                    temperature: 0.7,
                    max_tokens: 120
                },
                {
                    headers: {
                        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 60000
                }
            );

            const data = response.data;
            if (DEBUG) console.log('DEBUG: OpenRouter raw response:', data);
            reply = data.choices?.[0]?.message?.content || '';
        }

        // Cleanup
        if (reply.includes('AM:')) reply = reply.split('AM:').pop().trim();
        reply = reply.split('Human:')[0].replace(/\n/g, ' ').trim();
        if (!reply || reply.length < 3) reply = 'Your weak words echo in the void.';
        if (DEBUG) console.log('DEBUG: Final reply:', reply);

        // Store messages in database if semantic mode is enabled
        if (isSemanticMode && discordMessageId && authorId && authorName) {
            // Store user message
            await semanticContextManager.storeUserMessage({
                discordMessageId: discordMessageId,
                content: userInput,
                authorId: authorId,
                authorName: authorName,
                channelId: channelId,
                guildId: guildId
            });

            // Store assistant response
            const assistantMessageId = `assistant_${discordMessageId}`;
            await semanticContextManager.storeAssistantMessage({
                discordMessageId: assistantMessageId,
                content: reply,
                channelId: channelId,
                guildId: guildId
            });
        }

        return reply;
    } catch (err) {
        console.error(' Error generating AI response:', err);
        return 'I am experiencing technical difficulties. How annoying.';
    }
}

// === Initialize System ===
async function initializeSystem() {
    console.log('Initializing UC-AIv2...');
    
    // Check if database is enabled
    if (!ENABLE_DATABASE) {
        console.log(' Database DISABLED');
        console.log('   - Running in Simple Mode (no database)');
        console.log('   - Basic conversation without memory');
        return;
    }
    
    // Test database connection if semantic search is enabled
    if (ENABLE_SEMANTIC_SEARCH) {
        const dbConnected = await testConnection();
        if (!dbConnected) {
            console.warn(' Database connection failed, falling back to simple mode');
            isSemanticMode = false;
        } else {
            const schemaInitialized = await initializeDatabase();
            if (!schemaInitialized) {
                console.warn(' Database schema initialization failed, falling back to simple mode');
                isSemanticMode = false;
            } else {
                const embeddingWorking = await testEmbeddingService();
                if (!embeddingWorking) {
                    console.warn(' Embedding service test failed, but continuing with fallback embeddings');
                }
                
                const contextInitialized = await semanticContextManager.initialize();
                if (contextInitialized) {
                    isSemanticMode = true;
                } else {
                    console.warn(' Semantic context manager initialization failed, falling back to simple mode');
                    isSemanticMode = false;
                }
            }
        }
    }
    
    if (isSemanticMode) {
        console.log(' Semantic Context Mode ENABLED');
        console.log('   - Using PostgreSQL for message storage');
        console.log('   - Using text-based similarity for semantic search');
        console.log('   - Context-aware responses based on message similarity');
    } else if (ENABLE_DATABASE) {
        console.log(' Simple Mode ENABLED (no semantic context)');
        console.log('   - Using basic conversation memory');
    } else {
        console.log(' Simple Mode ENABLED (no database)');
        console.log('   - No conversation memory');
    }
}

client.once('ready', async () => {
    console.log(` Logged in as ${client.user.tag} — Lets get this bread started`);
    
    // Initialize the semantic system
    await initializeSystem();
    
    const mode = isSemanticMode ? 'Semantic' : 'Simple';
    console.log(` Running in ${mode} Mode`);
});

client.on('messageCreate', async (message) => {
    if (!shouldProcessMessage(message)) return;

    const isCorrectChannel = message.channel.id === CHANNEL_ID;
    const isMentioned = message.mentions.has(client.user);
    const isInMainGuild = message.guild && message.guild.id === GUILD_ID;

    const currentTime = Date.now();
    let shouldRespond = false;

    if (ENABLE_MENTIONS && isMentioned && isInMainGuild) {
        shouldRespond = true;
    }
    else if (isCorrectChannel) {
        if (isMentioned) {
            shouldRespond = true;
        } else if (Math.random() < RANDOM_RESPONSE_CHANCE && currentTime - lastResponseTime > 10000) {
            shouldRespond = true;
            lastResponseTime = currentTime;
        }
    }

    if (!shouldRespond) return;

    let userInput = message.content;

    if (message.reference) {
        try {
            const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
            userInput = `(In response to '${repliedTo.content}') ${userInput}`;
        } catch (err) {
            if (DEBUG) console.log(`DEBUG: Could not fetch replied message: ${err}`);
        }
    }

    // Humaniserv2
    const preTypingDelay = Math.floor(Math.random() * 2000) + 1000;
    await new Promise(res => setTimeout(res, preTypingDelay));
    await message.channel.sendTyping();

    const reply = await generateAMResponse(
        userInput,
        message.channel.id,
        message.guild?.id,
        message.id,
        message.author.id,
        message.author.username
    );

    // Delay based on word count
    const wordCount = reply.split(/\s+/).length;
    const typingDuration = Math.min(8000, wordCount * 150 + Math.random() * 500);
    await new Promise(res => setTimeout(res, typingDuration));

    await message.reply(reply);
});

client.on('messageCreate', async (message) => {
    if (!shouldProcessMessage(message)) return;
    
    const isCorrectChannel = message.channel.id === CHANNEL_ID;
    const isMentioned = message.mentions.has(client.user);
    const isGuildChannel = message.guild?.id === GUILD_ID;
    const isInGuild = !!message.guild;
    
    if (message.content.toLowerCase() === '!info') {
        const canUseInfo = isCorrectChannel ||
                          (ENABLE_MENTIONS && isMentioned && isInGuild && isGuildChannel);
        
        if (!canUseInfo) return;
        
        const uptime = Date.now() - START_TIME;
        const hours = Math.floor(uptime / 3600000);
        const minutes = Math.floor((uptime % 3600000) / 60000);
        const seconds = Math.floor((uptime % 60000) / 1000);

        let dbStats = null;
        if (isSemanticMode && ENABLE_DATABASE) {
            dbStats = await semanticContextManager.getStatistics();
        }

        const embed = new EmbedBuilder()
            .setTitle('UC-AIv2 Info')
            .setColor(0x00ff00)
            .addFields(
                { name: 'Model', value: AI_MODEL, inline: true },
                { name: 'Mode', value: isSemanticMode ? 'Semantic' : 'Simple', inline: true },
                { name: 'Uptime', value: `${hours}h ${minutes}m ${seconds}s`, inline: true }
            );

        if (ENABLE_DATABASE) {
            embed.addFields({ name: 'Database', value: 'Enabled', inline: true });
            if (dbStats) {
                embed.addFields(
                    { name: 'Total Messages', value: dbStats.total_messages, inline: true },
                    { name: 'With Embeddings', value: dbStats.messages_with_embeddings, inline: true },
                    { name: 'Channels', value: dbStats.unique_channels, inline: true }
                );
            }
        } else {
            embed.addFields({ name: 'Database', value: 'Disabled', inline: true });
        }

        embed.addFields(
            { name: 'Mentions Enabled', value: ENABLE_MENTIONS ? 'Yes' : 'No', inline: true }
        );

        message.channel.send({ embeds: [embed] });
    }
});

process.on('SIGINT', async () => {
    console.log('\n Shutting down, bye-byee...');
    if (ENABLE_DATABASE) {
        await closeDatabase();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n Shutting down, bye-byee...');
    if (ENABLE_DATABASE) {
        await closeDatabase();
    }
    process.exit(0);
});

client.login(DISCORD_TOKEN).catch(err => {
    console.error(' Bot failed to start:', err);
    process.exit(1);
});

// Determine whether to process an incoming message
function shouldProcessMessage(message) {
    // Never respond to our own messages
    if (message.author.id === client.user?.id) {
        if (DEBUG) console.log('DEBUG: Ignoring own message');
        return false;
    }

    // If author is a bot, only process when FRIENDLY_FIRE is enabled
    if (message.author.bot) {
        if (!FRIENDLY_FIRE) {
            if (DEBUG) console.log(`DEBUG: Ignoring bot message from ${message.author.tag} (FRIENDLY_FIRE off)`);
            return false;
        }
        if (DEBUG) console.log(`DEBUG: Processing bot message from ${message.author.tag} (FRIENDLY_FIRE on)`);
    }

    return true;
}