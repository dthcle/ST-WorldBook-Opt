// One acknowledged request, plus the chat prefix ending at its most recent user.
// Kept in page memory only; never persist chat text or transport credentials.
export function replaySnapshot(ctx) {
    if (!Array.isArray(ctx?.chat)) return null;
    let index = ctx.chat.length - 1;
    while (index >= 0 && (!ctx.chat[index]?.is_user || ctx.chat[index]?.is_system)) index--;
    if (index < 0) return null;
    try {
        const chat = structuredClone(ctx.chat.slice(0, index + 1));
        return { chat, userText: String(chat[index].mes ?? '') };
    } catch { return null; }
}

// Replace only the contents of the captured array, not ST's exported binding.
// Originals retain identity and are restored even when the caller switches chats.
export function useRecordCopies(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return () => {};
    const originals = Object.entries(record);
    const copy = structuredClone(record);
    for (const key of Object.keys(record)) delete record[key];
    Object.assign(record, copy);
    return () => {
        for (const key of Object.keys(record)) delete record[key];
        for (const [key, value] of originals) record[key] = value;
    };
}

export function useReplayChat(chat, snapshot) {
    if (!Array.isArray(chat) || !Array.isArray(snapshot?.chat)) throw new Error('上次发送缺少可重放的聊天快照。');
    const originals = chat.slice();
    const copies = structuredClone(snapshot.chat);
    chat.length = 0;
    for (const message of copies) chat.push(message);
    let restored = false;
    return () => {
        if (restored) return;
        restored = true;
        chat.length = 0;
        for (const message of originals) chat.push(message);
    };
}
