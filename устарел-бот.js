const fs = require("fs");
const path = require("path");

const WebSocket = globalThis.WebSocket;

if (!WebSocket) {
    console.error(
        "[FATAL] В этой версии Node.js отсутствует встроенный WebSocket."
    );
    process.exit(1);
}

const CONFIG_PATH = path.join(__dirname, "config.json");
const DATABASE_PATH = path.join(__dirname, "database.json");

const config = JSON.parse(
    fs.readFileSync(CONFIG_PATH, "utf8")
);

let database = {};

if (fs.existsSync(DATABASE_PATH)) {
    try {
        database = JSON.parse(
            fs.readFileSync(DATABASE_PATH, "utf8")
        );
    } catch (error) {
        console.error(
            "[DATABASE] Ошибка чтения:",
            error.message
        );

        database = {};
    }
}

function saveDatabase() {
    fs.writeFileSync(
        DATABASE_PATH,
        JSON.stringify(database, null, 2),
        "utf8"
    );
}

/* =========================================================
   DISCORD API
========================================================= */

const API = "https://discord.com/api/v10";

async function discordRequest(endpoint, options = {}) {
    const response = await fetch(
        `${API}${endpoint}`,
        {
            ...options,

            headers: {
                Authorization:
                    `Bot ${config.botToken}`,

                "Content-Type":
                    "application/json",

                ...(options.headers || {})
            }
        }
    );

    if (response.status === 204) {
        return null;
    }

    const text =
        await response.text();

    let data;

    try {
        data =
            text
                ? JSON.parse(text)
                : null;
    } catch {
        data = text;
    }

    if (!response.ok) {
        throw new Error(
            `Discord API ${response.status}: ${JSON.stringify(data)}`
        );
    }

    return data;
}

/* =========================================================
   MESSAGES
========================================================= */

async function sendMessage(
    channelId,
    content,
    components = []
) {
    return discordRequest(
        `/channels/${channelId}/messages`,
        {
            method: "POST",

            body: JSON.stringify({
                content,
                components
            })
        }
    );
}

async function dmUser(
    userId,
    content
) {
    const channel =
        await discordRequest(
            "/users/@me/channels",
            {
                method: "POST",

                body: JSON.stringify({
                    recipient_id: userId
                })
            }
        );

    return sendMessage(
        channel.id,
        content
    );
}

/* =========================================================
   MEMBERS
========================================================= */

/*
    Пользователи Minecraft-сервера
    ищутся ТОЛЬКО на SOURCE SERVER.
*/

async function getSourceMember(
    userId
) {
    try {
        return await discordRequest(
            `/guilds/${config.sourceGuildId}/members/${userId}`
        );
    } catch {
        return null;
    }
}

/*
    Администраторы проверяются
    ТОЛЬКО на STAFF SERVER.
*/

async function getStaffMember(
    userId
) {
    try {
        return await discordRequest(
            `/guilds/${config.staffGuildId}/members/${userId}`
        );
    } catch {
        return null;
    }
}

/* =========================================================
   DATABASE
========================================================= */

function getUser(userId) {
    if (!database[userId]) {
        database[userId] = {
            discordId: userId,

            minecraftNick: null,

            accessType: "none",

            subscription: null,
            subscriptionName: null,

            freeAccess: false,

            hasAccess: false,

            applicationStatus: null,
            applicationSource: null,
            applicationMessageId: null,

            whitelisted: false,

            createdAt:
                new Date().toISOString(),

            updatedAt:
                new Date().toISOString()
        };

        saveDatabase();
    }

    const user =
        database[userId];

    if (!("freeAccess" in user)) {
        user.freeAccess = false;
    }

    if (!("accessType" in user)) {
        if (user.freeAccess) {
            user.accessType = "free";
        } else if (user.subscription) {
            user.accessType = "paid";
        } else {
            user.accessType =
                user.hasAccess
                    ? "paid"
                    : "none";
        }
    }

    if (!("hasAccess" in user)) {
        user.hasAccess =
            user.accessType !== "none";
    }

    if (!("minecraftNick" in user)) {
        user.minecraftNick = null;
    }

    if (!("subscription" in user)) {
        user.subscription = null;
    }

    if (!("subscriptionName" in user)) {
        user.subscriptionName = null;
    }

    return user;
}

function updateUser(
    userId,
    changes
) {
    const user =
        getUser(userId);

    Object.assign(
        user,
        changes
    );

    user.updatedAt =
        new Date().toISOString();

    database[userId] =
        user;

    saveDatabase();

    return user;
}

function deleteUser(
    userId
) {
    if (!database[userId]) {
        return false;
    }

    delete database[userId];

    saveDatabase();

    return true;
}

/* =========================================================
   SOURCE SERVER ROLES
========================================================= */

function getSubscriptionFromRoles(
    roleIds
) {
    if (
        roleIds.includes(
            config.roles.x0.id
        )
    ) {
        return {
            type: "x0",
            name:
                config.roles.x0.name
        };
    }

    if (
        roleIds.includes(
            config.roles.x1.id
        )
    ) {
        return {
            type: "x1",
            name:
                config.roles.x1.name
        };
    }

    return null;
}

function getRoleNames(
    roleIds
) {
    const names = [];

    for (
        const roleId of roleIds
    ) {
        if (
            roleId ===
            config.roles.x0.id
        ) {
            names.push(
                config.roles.x0.name
            );
        } else if (
            roleId ===
            config.roles.x1.id
        ) {
            names.push(
                config.roles.x1.name
            );
        }
    }

    return names;
}

/* =========================================================
   STAFF CHECK
========================================================= */

async function isStaff(
    userId
) {
    const member =
        await getStaffMember(
            userId
        );

    if (!member) {
        return false;
    }

    return (
        member.roles || []
    ).includes(
        config.staffRoleId
    );
}

/* =========================================================
   LOGGING
========================================================= */

async function logStaff(
    message
) {
    try {
        await sendMessage(
            config.channels.roleLogs,
            message
        );
    } catch (error) {
        console.error(
            "[LOG ERROR]",
            error.message
        );
    }
}

/* =========================================================
   ROLE CHANGES
========================================================= */

async function logAllRoleChanges(
    userId,
    oldRoles,
    newRoles,
    member
) {
    const oldSet =
        new Set(oldRoles);

    const newSet =
        new Set(newRoles);

    const added =
        newRoles.filter(
            role =>
                !oldSet.has(role)
        );

    const removed =
        oldRoles.filter(
            role =>
                !newSet.has(role)
        );

    if (
        !added.length &&
        !removed.length
    ) {
        return;
    }

    const addedNames =
        getRoleNames(added);

    const removedNames =
        getRoleNames(removed);

    const username =
        member.user?.username ||
        member.user?.global_name ||
        userId;

    let message =
        `📋 **Изменение ролей**\n` +
        `Пользователь: <@${userId}> (${username})\n`;

    if (addedNames.length) {
        message +=
            `➕ Добавлены: ${addedNames.join(", ")}\n`;
    }

    if (removedNames.length) {
        message +=
            `➖ Сняты: ${removedNames.join(", ")}\n`;
    }

    await logStaff(
        message
    );
}

/* =========================================================
   SUBSCRIPTIONS
========================================================= */

async function handleSubscriptionChange(
    userId,
    oldRoles,
    newRoles
) {
    const oldSubscription =
        getSubscriptionFromRoles(
            oldRoles
        );

    const newSubscription =
        getSubscriptionFromRoles(
            newRoles
        );

    const user =
        getUser(userId);

    if (
        oldSubscription?.type ===
        newSubscription?.type
    ) {
        return;
    }

    /*
        НОВАЯ ПОДПИСКА
    */

    if (
        !oldSubscription &&
        newSubscription
    ) {
        updateUser(userId, {
            accessType: "paid",

            subscription:
                newSubscription.type,

            subscriptionName:
                newSubscription.name,

            freeAccess: false,

            hasAccess: true,

            subscriptionStartedAt:
                new Date().toISOString()
        });

        await logStaff(
            `🟢 **Выдана платная проходка**\n` +
            `Пользователь: <@${userId}>\n` +
            `Discord ID: \`${userId}\`\n` +
            `Тип: **${newSubscription.name}**\n` +
            `Minecraft: \`${user.minecraftNick || "ещё не указан"}\``
        );

        try {
            await dmUser(
                userId,
                config.messages.subscriptionDm
            );
        } catch (error) {
            console.error(
                "[DM]",
                error.message
            );
        }

        return;
    }

    /*
        X0 -> X1
        X1 -> X0
    */

    if (
        oldSubscription &&
        newSubscription
    ) {
        updateUser(userId, {
            accessType: "paid",

            subscription:
                newSubscription.type,

            subscriptionName:
                newSubscription.name,

            freeAccess: false,

            hasAccess: true
        });

        await logStaff(
            `🔄 **Изменена подписка**\n` +
            `Пользователь: <@${userId}>\n` +
            `Minecraft: \`${user.minecraftNick || "не указан"}\`\n` +
            `Было: **${oldSubscription.name}**\n` +
            `Стало: **${newSubscription.name}**`
        );

        return;
    }

    /*
        ПОДПИСКА СНЯТА
    */

    if (
        oldSubscription &&
        !newSubscription
    ) {
        if (user.freeAccess) {
            updateUser(userId, {
                accessType: "free",

                subscription: null,

                subscriptionName: null,

                hasAccess: true
            });

            await logStaff(
                `🟡 **Платная подписка снята, бесплатный доступ сохранён**\n` +
                `Пользователь: <@${userId}>`
            );

            return;
        }

        updateUser(userId, {
            accessType: "none",

            subscription: null,

            subscriptionName: null,

            hasAccess: false,

            subscriptionEndedAt:
                new Date().toISOString()
        });

        await logStaff(
            `🔴 **ПЛАТНАЯ ПРОХОДКА СНЯТА**\n\n` +
            `Пользователь: <@${userId}>\n` +
            `Discord ID: \`${userId}\`\n` +
            `Minecraft: \`${user.minecraftNick || "НЕ УКАЗАН"}\`\n` +
            `Бывшая подписка: **${oldSubscription.name}**\n\n` +
            `⚠️ Нужно удалить из whitelist.`
        );

        try {
            if (
                user.minecraftNick
            ) {
                await dmUser(
                    userId,
                    config.messages.whitelistRemoved
                );
            }
        } catch (error) {
            console.error(
                "[DM]",
                error.message
            );
        }
    }
}

/* =========================================================
   MEMBER UPDATE
========================================================= */

async function handleMemberUpdate(
    member
) {
    const userId =
        member.user.id;

    const newRoles =
        member.roles || [];

    const oldRoles =
        roleSnapshot[userId] || [];

    if (oldRoles.length) {
        await logAllRoleChanges(
            userId,
            oldRoles,
            newRoles,
            member
        );
    }

    await handleSubscriptionChange(
        userId,
        oldRoles,
        newRoles
    );

    roleSnapshot[userId] =
        [...newRoles];
}

/* =========================================================
   MINECRAFT
========================================================= */

function validMinecraftNickname(
    nickname
) {
    return /^[A-Za-z0-9_]{3,16}$/.test(
        nickname
    );
}

/* =========================================================
   APPLICATION
========================================================= */

async function createApplication(
    userId,
    minecraftNick,
    source = "subscription"
) {
    const user =
        getUser(userId);

    updateUser(userId, {
        minecraftNick,

        applicationStatus:
            "pending",

        whitelisted: false,

        applicationSource:
            source,

        applicationCreatedAt:
            new Date().toISOString()
    });

    const subscriptionText =
        user.subscriptionName ||
        (
            source === "free"
                ? "Бесплатная проходка"
                : "Не указано"
        );

    const message =
        `🐸 **Новая заявка на проходку**\n\n` +
        `Discord: <@${userId}>\n` +
        `Discord ID: \`${userId}\`\n` +
        `Minecraft: \`${minecraftNick}\`\n` +
        `Тип: **${subscriptionText}**\n` +
        `Доступ: **${user.accessType}**\n` +
        `Источник: **${source === "free" ? "бесплатная выдача" : "подписка"}**\n\n` +
        `Статус: 🟡 Ожидает добавления в whitelist.`;

    const components = [
        {
            type: 1,

            components: [
                {
                    type: 2,

                    style: 3,

                    label:
                        "Я добавил в whitelist",

                    custom_id:
                        `mark_done:${userId}`
                }
            ]
        }
    ];

    const applicationMessage =
        await sendMessage(
            config.channels.applications,
            message,
            components
        );

    updateUser(userId, {
        applicationMessageId:
            applicationMessage?.id ||
            null
    });

    await dmUser(
        userId,

        config.messages.nicknameAccepted
            .replace(
                "{nickname}",
                minecraftNick
            )
    );
}

/* =========================================================
   DM
========================================================= */

async function handleDM(message) {
    const userId = message.author.id;

    if (message.author.bot) {
        return;
    }

    const nickname = message.content.trim();

    const user = getUser(userId);

    /*
        Никакой проверки наличия пользователя
        на Discord-серверах здесь НЕТ.

        Решение принимается по database.json.
    */

    if (!user.hasAccess) {
        await dmUser(
            userId,
            "❌ У вас сейчас нет активной проходки."
        );

        return;
    }

    /*
        Уже есть активная заявка.
    */
    if (
        user.minecraftNick &&
        (
            user.applicationStatus === "pending" ||
            user.applicationStatus === "whitelisted_manual"
        )
    ) {
        await dmUser(
            userId,
            config.messages.alreadyRegistered
                .replace(
                    "{nickname}",
                    user.minecraftNick
                )
        );

        return;
    }

    /*
        Проверка Minecraft ника.
    */
    if (!validMinecraftNickname(nickname)) {
        await dmUser(
            userId,
            config.messages.invalidNickname
        );

        return;
    }

    /*
        Если это платная проходка,
        пробуем определить актуальную роль
        на SOURCE-сервере.

        Если пользователя там нет —
        это НЕ ошибка.
    */
    if (user.accessType === "paid") {
        const member =
            await getSourceGuildMember(userId);

        if (member) {
            const subscription =
                getSubscriptionFromRoles(
                    member.roles || []
                );

            if (subscription) {
                updateUser(userId, {
                    accessType: "paid",
                    subscription: subscription.type,
                    subscriptionName: subscription.name,
                    freeAccess: false,
                    hasAccess: true
                });
            }
        }
    }

    const updatedUser = getUser(userId);

    await createApplication(
        userId,
        nickname,
        updatedUser.accessType === "free"
            ? "free"
            : "subscription"
    );

    console.log(
        `[APPLICATION] ${userId} -> ${nickname}`
    );
}
/* =========================================================
   INTERACTION RESPONSE
========================================================= */

/*
    ПУБЛИЧНЫЙ ответ.
*/

async function interactionResponse(
    interaction,
    content
) {
    return discordRequest(
        `/interactions/${interaction.id}/${interaction.token}/callback`,
        {
            method: "POST",

            body: JSON.stringify({
                type: 4,

                data: {
                    content
                }
            })
        }
    );
}

/*
    MODAL.
*/

async function showModal(
    interaction,
    customId,
    title,
    components
) {
    return discordRequest(
        `/interactions/${interaction.id}/${interaction.token}/callback`,
        {
            method: "POST",

            body: JSON.stringify({
                type: 9,

                data: {
                    custom_id:
                        customId,

                    title,

                    components
                }
            })
        }
    );
}

/* =========================================================
   MODAL VALUES
========================================================= */

function getModalValue(
    interaction,
    customId
) {
    const components =
        interaction.data
            ?.components || [];

    for (
        const row of components
    ) {
        for (
            const component of
            row.components || []
        ) {
            if (
                component.custom_id ===
                customId
            ) {
                return (
                    component.value ||
                    ""
                ).trim();
            }
        }
    }

    return "";
}

/* =========================================================
   PAID MODAL
========================================================= */

async function openPaidModal(
    interaction
) {
    return showModal(
        interaction,

        "modal_paid",

        "Выдать проходку",

        [
            {
                type: 1,

                components: [
                    {
                        type: 4,

                        custom_id:
                            "discord_id",

                        label:
                            "Discord ID пользователя",

                        style: 1,

                        min_length: 15,

                        max_length: 25,

                        required: true,

                        placeholder:
                            "Например: 123456789012345678"
                    }
                ]
            }
        ]
    );
}

/* =========================================================
   FREE MODAL
========================================================= */

async function openFreeModal(
    interaction
) {
    return showModal(
        interaction,

        "modal_free",

        "Выдать бесплатно",

        [
            {
                type: 1,

                components: [
                    {
                        type: 4,

                        custom_id:
                            "discord_id",

                        label:
                            "Discord ID пользователя",

                        style: 1,

                        min_length: 15,

                        max_length: 25,

                        required: true,

                        placeholder:
                            "Например: 123456789012345678"
                    }
                ]
            }
        ]
    );
}

/* =========================================================
   GIVE ACCESS
========================================================= */

async function giveAccess(targetId, free = false) {

    const user = getUser(targetId);

    /*
        ============================
        БЕСПЛАТНАЯ ПРОХОДКА
        ============================
    */

    if (free) {

        updateUser(targetId, {
            accessType: "free",
            freeAccess: true,

            subscription: null,
            subscriptionName: null,

            hasAccess: true,

            applicationStatus: null,
            applicationSource: "free",

            whitelisted: false
        });

        await dmUser(
            targetId,
            config.messages.freeDm
        );

        await logStaff(
            `🟢 **Выдан бесплатный доступ**\n` +
            `Пользователь: <@${targetId}>\n` +
            `Discord ID: \`${targetId}\`\n` +
            `Minecraft: \`${user.minecraftNick || "ещё не указан"}\``
        );

        return;
    }

    /*
        ============================
        ПЛАТНАЯ ПРОХОДКА
        ============================
    */

    /*
        Проверяем роль ТОЛЬКО на SOURCE-сервере.

        Отсутствие пользователя там НЕ является
        ошибкой.
    */

    const member =
        await getSourceGuildMember(targetId);

    let subscription = null;

    if (member) {
        subscription =
            getSubscriptionFromRoles(
                member.roles || []
            );
    }

    /*
        Если роль найдена — используем её.
    */

    if (subscription) {

        updateUser(targetId, {
            accessType: "paid",

            freeAccess: false,

            subscription:
                subscription.type,

            subscriptionName:
                subscription.name,

            hasAccess: true,

            applicationStatus: null,
            applicationSource: "subscription",

            whitelisted: false
        });

        await dmUser(
            targetId,
            config.messages.subscriptionDm
        );

        await logStaff(
            `🟢 **Платная проходка выдана**\n` +
            `Пользователь: <@${targetId}>\n` +
            `Discord ID: \`${targetId}\`\n` +
            `Тип: **${subscription.name}**`
        );

        return;
    }

    /*
        Если пользователя нет на Source-сервере,
        либо у него нет платной роли, но он уже
        имеет платный доступ в базе — НЕ ломаем выдачу.
    */

    if (
        user.accessType === "paid" &&
        user.subscription
    ) {

        updateUser(targetId, {
            hasAccess: true
        });

        await dmUser(
            targetId,
            config.messages.subscriptionDm
        );

        await logStaff(
            `🟢 **Платная проходка выдана из базы**\n` +
            `Пользователь: <@${targetId}>\n` +
            `Discord ID: \`${targetId}\`\n` +
            `Тип: **${user.subscriptionName || user.subscription}**`
        );

        return;
    }

    /*
        Ничего не нашли.
    */

    throw new Error(
        "У пользователя нет платной роли и платного доступа в базе."
    );
}

/* =========================================================
   WHITELIST
========================================================= */

async function markWhitelistDone(
    userId,
    interaction
) {
    const user =
        getUser(userId);

    if (!user.minecraftNick) {
        await interactionResponse(
            interaction,
            "❌ У пользователя нет Minecraft-ника."
        );

        return;
    }

    updateUser(userId, {
        whitelisted: true,

        applicationStatus:
            "whitelisted_manual",

        whitelistedAt:
            new Date().toISOString(),

        whitelistedBy:
            interaction.member.user.id
    });

    await interactionResponse(
        interaction,

        `✅ \`${user.minecraftNick}\` отмечен как добавленный в whitelist.`
    );

    try {
        await dmUser(
            userId,

            config.messages.whitelisted
                .replace(
                    "{nickname}",
                    user.minecraftNick
                )
        );
    } catch (error) {
        console.error(
            "[WHITELIST DM]",
            error.message
        );
    }

    await logStaff(
        `✅ **Игрок добавлен в whitelist**\n` +
        `Пользователь: <@${userId}>\n` +
        `Minecraft: \`${user.minecraftNick}\`\n` +
        `Подтвердил: <@${interaction.member.user.id}>`
    );
}

/* =========================================================
   INTERACTIONS
========================================================= */

async function handleInteraction(interaction) {
    /*
        Нас интересуют:
        3 = MESSAGE_COMPONENT
        5 = MODAL_SUBMIT
    */

    if (
        interaction.type !== 3 &&
        interaction.type !== 5
    ) {
        return;
    }

    const customId =
        interaction.data?.custom_id;

    if (!customId) {
        return;
    }

    /* =====================================================
       КНОПКА: Я ДОБАВИЛ В WHITELIST
    ===================================================== */

    if (
        customId.startsWith("mark_done:")
    ) {
        if (
            !isStaffInteraction(interaction)
        ) {
            await interactionResponse(
                interaction,
                "❌ У вас нет прав для этого."
            );

            return;
        }

        const userId =
            customId.split(":")[1];

        await markWhitelistDone(
            userId,
            interaction
        );

        return;
    }

    /* =====================================================
       КНОПКА: ВЫДАТЬ ПРОХОДКУ
    ===================================================== */

    if (
        customId === "choose_paid"
    ) {
        if (
            !isStaffInteraction(interaction)
        ) {
            await interactionResponse(
                interaction,
                "❌ У вас нет прав для этого."
            );

            return;
        }

        await interactionModal(
            interaction,
            {
                custom_id: "paid_access_modal",
                title: "Выдать проходку",
                components: [
                    {
                        type: 1,
                        components: [
                            {
                                type: 4,
                                custom_id: "user_id",
                                label: "Discord ID пользователя",
                                style: 1,
                                min_length: 15,
                                max_length: 25,
                                required: true,
                                placeholder: "123456789012345678"
                            }
                        ]
                    }
                ]
            }
        );

        return;
    }

    /* =====================================================
       КНОПКА: ВЫДАТЬ БЕСПЛАТНО
    ===================================================== */

    if (
        customId === "choose_free"
    ) {
        if (
            !isStaffInteraction(interaction)
        ) {
            await interactionResponse(
                interaction,
                "❌ У вас нет прав для этого."
            );

            return;
        }

        await interactionModal(
            interaction,
            {
                custom_id: "free_access_modal",
                title: "Бесплатная проходка",
                components: [
                    {
                        type: 1,
                        components: [
                            {
                                type: 4,
                                custom_id: "user_id",
                                label: "Discord ID пользователя",
                                style: 1,
                                min_length: 15,
                                max_length: 25,
                                required: true,
                                placeholder: "123456789012345678"
                            }
                        ]
                    }
                ]
            }
        );

        return;
    }

    /* =====================================================
       MODAL: ПЛАТНАЯ ПРОХОДКА
    ===================================================== */

    if (
        customId === "paid_access_modal"
    ) {
        if (
            !isStaffInteraction(interaction)
        ) {
            await interactionResponse(
                interaction,
                "❌ У вас нет прав для этого."
            );

            return;
        }

        const userId =
            interaction.data.components
                ?.find(row =>
                    row.components?.some(
                        component =>
                            component.custom_id ===
                            "user_id"
                    )
                )
                ?.components
                ?.find(
                    component =>
                        component.custom_id ===
                        "user_id"
                )
                ?.value
                ?.trim();

        if (
            !userId ||
            !/^\d{15,25}$/.test(userId)
        ) {
            await interactionResponse(
                interaction,
                "❌ Некорректный Discord ID."
            );

            return;
        }

        try {
            await giveAccess(
                userId,
                false
            );

            await interactionResponse(
                interaction,
                `✅ Платная проходка выдана пользователю <@${userId}>.`
            );
        } catch (error) {
            await interactionResponse(
                interaction,
                `❌ ${error.message}`
            );
        }

        return;
    }

    /* =====================================================
       MODAL: БЕСПЛАТНАЯ ПРОХОДКА
    ===================================================== */

    if (
        customId === "free_access_modal"
    ) {
        if (
            !isStaffInteraction(interaction)
        ) {
            await interactionResponse(
                interaction,
                "❌ У вас нет прав для этого."
            );

            return;
        }

        const userId =
            interaction.data.components
                ?.find(row =>
                    row.components?.some(
                        component =>
                            component.custom_id ===
                            "user_id"
                    )
                )
                ?.components
                ?.find(
                    component =>
                        component.custom_id ===
                        "user_id"
                )
                ?.value
                ?.trim();

        if (
            !userId ||
            !/^\d{15,25}$/.test(userId)
        ) {
            await interactionResponse(
                interaction,
                "❌ Некорректный Discord ID."
            );

            return;
        }

        try {
            await giveAccess(
                userId,
                true
            );

            await interactionResponse(
                interaction,
                `✅ Бесплатная проходка выдана пользователю <@${userId}>.`
            );
        } catch (error) {
            await interactionResponse(
                interaction,
                `❌ ${error.message}`
            );
        }

        return;
    }
}

/* =========================================================
   STAFF PANEL
========================================================= */

async function createPanel(
    channelId
) {
    const components = [
        {
            type: 1,

            components: [
                {
                    type: 2,

                    style: 1,

                    label:
                        config.panel.paidButton,

                    custom_id:
                        "choose_paid"
                },

                {
                    type: 2,

                    style: 2,

                    label:
                        config.panel.freeButton,

                    custom_id:
                        "choose_free"
                }
            ]
        }
    ];

    await sendMessage(
        channelId,

        config.panel.text,

        components
    );
}

/* =========================================================
   STAFF MESSAGES
========================================================= */

async function handleStaffMessage(
    message
) {
    if (
        message.author?.bot
    ) {
        return;
    }

    if (
        message.guild_id !==
        config.staffGuildId
    ) {
        return;
    }

    const staff =
        await isStaff(
            message.author.id
        );

    if (!staff) {
        return;
    }

    const content =
        (
            message.content || ""
        ).trim();

    /*
        ПАНЕЛЬ
    */

    if (
        content ===
            "!панель-заявок" ||

        content ===
            "!application-panel" ||

        content ===
            "!panel"
    ) {
        await createPanel(
            message.channel_id
        );

        return;
    }

    /*
        !заявка @user
    */

    if (
        content.startsWith(
            "!заявка"
        )
    ) {
        const match =
            content.match(
                /<@!?(\d{15,25})>/
            );

        if (!match) {
            await sendMessage(
                message.channel_id,

                "Использование: `!заявка @пользователь`"
            );

            return;
        }

        const targetId =
            match[1];

        try {
            await giveAccess(
                targetId,
                false
            );

            await sendMessage(
                message.channel_id,

                `✅ Проходка выдана <@${targetId}>.`
            );
        } catch (error) {
            await sendMessage(
                message.channel_id,

                `❌ ${error.message}`
            );
        }

        return;
    }

    /*
        !бесплатно @user
    */

    if (
        content.startsWith(
            "!бесплатно"
        )
    ) {
        const match =
            content.match(
                /<@!?(\d{15,25})>/
            );

        if (!match) {
            await sendMessage(
                message.channel_id,

                "Использование: `!бесплатно @пользователь`"
            );

            return;
        }

        const targetId =
            match[1];

        try {
            await giveAccess(
                targetId,
                true
            );

            await sendMessage(
                message.channel_id,

                `✅ Бесплатная проходка выдана <@${targetId}>.`
            );
        } catch (error) {
            await sendMessage(
                message.channel_id,

                `❌ ${error.message}`
            );
        }

        return;
    }
}

/* =========================================================
   SOURCE GUILD MEMBERS
========================================================= */

let roleSnapshot = {};

async function getAllSourceMembers() {
    const members = [];

    let after = "0";

    while (true) {
        const params =
            new URLSearchParams({
                limit: "1000"
            });

        if (
            after !== "0"
        ) {
            params.set(
                "after",
                after
            );
        }

        const batch =
            await discordRequest(
                `/guilds/${config.sourceGuildId}/members?${params}`
            );

        if (
            !batch.length
        ) {
            break;
        }

        members.push(
            ...batch
        );

        if (
            batch.length < 1000
        ) {
            break;
        }

        after =
            batch[
                batch.length - 1
            ].user.id;
    }

    return members;
}

async function startupRoleSync() {
    console.log(
        "[SYNC] Проверяю роли SOURCE сервера..."
    );

    try {
        const members =
            await getAllSourceMembers();

        for (
            const member of members
        ) {
            const userId =
                member.user.id;

            const roles =
                member.roles || [];

            const oldRoles =
                roleSnapshot[userId];

            /*
                Первый запуск —
                просто сохраняем snapshot.
            */

            if (!oldRoles) {
                roleSnapshot[userId] =
                    [...roles];

                continue;
            }

            if (
                JSON.stringify(
                    oldRoles
                ) !==
                JSON.stringify(
                    roles
                )
            ) {
                await handleMemberUpdate(
                    member
                );
            }
        }

        console.log(
            `[SYNC] SOURCE: ${members.length} участников`
        );
    } catch (error) {
        console.error(
            "[SYNC ERROR]",
            error.message
        );
    }
}

/* =========================================================
   GATEWAY
========================================================= */

let ws = null;

let sequence = null;

let sessionId = null;

let resumeGatewayUrl = null;

let heartbeatTimer = null;

let reconnectTimer = null;

function identifyPayload() {
    /*
        GUILDS
        GUILD_MEMBERS
        GUILD_MESSAGES
        DIRECT_MESSAGES
        MESSAGE_CONTENT
    */

    const intents =
        1 |
        2 |
        512 |
        4096 |
        32768;

    return {
        op: 2,

        d: {
            token:
                config.botToken,

            intents,

            properties: {
                os: "windows",

                browser:
                    "frogwork-bot",

                device:
                    "frogwork-bot"
            }
        }
    };
}

function heartbeat() {
    if (!ws) {
        return;
    }

    try {
        ws.send(
            JSON.stringify({
                op: 1,
                d: sequence
            })
        );
    } catch (error) {
        console.error(
            "[HEARTBEAT]",
            error.message
        );
    }
}

function startHeartbeat(
    interval
) {
    if (heartbeatTimer) {
        clearInterval(
            heartbeatTimer
        );
    }

    heartbeat();

    heartbeatTimer =
        setInterval(
            heartbeat,
            interval
        );
}

function reconnect(
    delay = 5000
) {
    if (reconnectTimer) {
        return;
    }

    reconnectTimer =
        setTimeout(
            () => {
                reconnectTimer =
                    null;

                connectGateway();
            },
            delay
        );
}

function connectGateway() {
    if (ws) {
        try {
            ws.close();
        } catch {}
    }

    const url =
        resumeGatewayUrl ||
        "wss://gateway.discord.gg/?v=10&encoding=json";

    console.log(
        "[GATEWAY] Подключение..."
    );

    ws =
        new WebSocket(url);

    ws.onopen = () => {
        console.log(
            "[GATEWAY] WebSocket подключён."
        );
    };

    ws.onmessage =
        async event => {
            let packet;

            try {
                packet =
                    JSON.parse(
                        event.data.toString()
                    );
            } catch {
                return;
            }

            if (
                packet.s !== null &&
                packet.s !== undefined
            ) {
                sequence =
                    packet.s;
            }

            switch (
                packet.op
            ) {
                /*
                    DISPATCH
                */

                case 0: {
                    const eventName =
                        packet.t;

                    const data =
                        packet.d;

                    /*
                        READY
                    */

                    if (
                        eventName ===
                        "READY"
                    ) {
                        sessionId =
                            data.session_id;

                        resumeGatewayUrl =
                            data.resume_gateway_url;

                        console.log(
                            `[READY] Бот запущен как ${data.user.username}`
                        );

                        console.log(
                            `[READY] Source guild: ${config.sourceGuildId}`
                        );

                        console.log(
                            `[READY] Staff guild: ${config.staffGuildId}`
                        );

                        await startupRoleSync();

                        break;
                    }

                    /*
                        SOURCE:
                        изменение ролей
                    */

                    if (
                        eventName ===
                        "GUILD_MEMBER_UPDATE"
                    ) {
                        if (
                            data.guild_id ===
                            config.sourceGuildId
                        ) {
                            await handleMemberUpdate(
                                data
                            );
                        }

                        break;
                    }

                    /*
                        MESSAGE_CREATE
                    */

                    if (
                        eventName ===
                        "MESSAGE_CREATE"
                    ) {
                        /*
                            DM
                        */

                        if (
                            !data.guild_id
                        ) {
                            await handleDM(
                                data
                            );

                            break;
                        }

                        /*
                            STAFF SERVER
                        */

                        if (
                            data.guild_id ===
                            config.staffGuildId
                        ) {
                            await handleStaffMessage(
                                data
                            );

                            break;
                        }

                        /*
                            SOURCE SERVER:
                            ничего не делаем.
                        */

                        break;
                    }

                    /*
                        INTERACTION_CREATE
                    */

                    if (
                        eventName ===
                        "INTERACTION_CREATE"
                    ) {
                        await handleInteraction(
                            data
                        );

                        break;
                    }

                    break;
                }

                /*
                    HELLO
                */

                case 10: {
                    startHeartbeat(
                        packet.d
                            .heartbeat_interval
                    );

                    if (
                        sessionId &&
                        sequence !== null &&
                        resumeGatewayUrl
                    ) {
                        ws.send(
                            JSON.stringify({
                                op: 6,

                                d: {
                                    token:
                                        config.botToken,

                                    session_id:
                                        sessionId,

                                    seq:
                                        sequence
                                }
                            })
                        );
                    } else {
                        ws.send(
                            JSON.stringify(
                                identifyPayload()
                            )
                        );
                    }

                    break;
                }

                /*
                    HEARTBEAT ACK
                */

                case 11:
                    break;

                /*
                    INVALID SESSION
                */

                case 9: {
                    console.error(
                        "[GATEWAY] Invalid Session"
                    );

                    sessionId = null;

                    sequence = null;

                    resumeGatewayUrl = null;

                    try {
                        ws.close();
                    } catch {}

                    reconnect(5000);

                    break;
                }

                /*
                    RECONNECT
                */

                case 7: {
                    console.log(
                        "[GATEWAY] Discord requested reconnect"
                    );

                    try {
                        ws.close();
                    } catch {}

                    reconnect(1000);

                    break;
                }

                default:
                    break;
            }
        };

    ws.onerror =
        error => {
            console.error(
                "[GATEWAY ERROR]",
                error.message
            );
        };

    ws.onclose =
        () => {
            console.log(
                "[GATEWAY] disconnected; reconnecting..."
            );

            reconnect(5000);
        };
}

/* =========================================================
   START
========================================================= */

async function start() {
    console.log(
        "========================================"
    );

    console.log(
        "🐸 FROGWORK ACCESS BOT"
    );

    console.log(
        "========================================"
    );

    console.log(
        `Source server: ${config.sourceGuildId}`
    );

    console.log(
        `Staff server:  ${config.staffGuildId}`
    );

    console.log(
        `Database:      ${DATABASE_PATH}`
    );

    console.log(
        "========================================"
    );

    try {
        const me =
            await discordRequest(
                "/users/@me"
            );

        console.log(
            `[BOT] ${me.username} (${me.id})`
        );
    } catch (error) {
        console.error(
            "[HTTP] Login failed:",
            error.message
        );

        process.exit(1);
    }

    connectGateway();

    /*
        Проверяем роли SOURCE
        каждые 10 минут.
    */

    setInterval(
        startupRoleSync,
        10 * 60 * 1000
    );
}

/* =========================================================
   SHUTDOWN
========================================================= */

function shutdown() {
    console.log(
        "[BOT] shutting down..."
    );

    if (heartbeatTimer) {
        clearInterval(
            heartbeatTimer
        );
    }

    if (reconnectTimer) {
        clearTimeout(
            reconnectTimer
        );
    }

    if (ws) {
        try {
            ws.close();
        } catch {}
    }

    process.exit(0);
}

process.on(
    "SIGINT",
    shutdown
);

process.on(
    "SIGTERM",
    shutdown
);

start();