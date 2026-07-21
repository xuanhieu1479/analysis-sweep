import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, reloadCurrentChat } from "../../../../script.js";
import { registerSlashCommand, executeSlashCommands } from "../../../slash-commands.js";
import { worldInfoCache } from "../../../world-info.js";

const extensionName = "analysis-sweep";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const defaultSettings = {
    pattern: [
        "What actually happened in the scene?",
        "What were the user's instructions?",
        "What logically follows?",
        "What do the characters realistically know and say?",
        "Am I overriding user's instructions?",
        "Am I pattern-matching?",
        "What am I assuming that wasn't explicitly stated?",
    ].join("\n"),
    threshold: 80,
    fuzzy: true,
    markedFingerprints: [],
    compactPattern: `[OOC: Background context:
{{content}}]`,
};

let lastScan = [];
let lastCompactScan = [];
let textareaDebounce = null;

function settings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (extension_settings[extensionName][k] === undefined) {
            extension_settings[extensionName][k] = structuredClone(v);
        }
    }
    return extension_settings[extensionName];
}

function fingerprint(msg) {
    // send_date + name is stable across index shifts in a single chat
    return `${msg.send_date || ""}::${msg.name || ""}`;
}

function isMarked(msg) {
    return settings().markedFingerprints.includes(fingerprint(msg));
}

function toggleMark(msg) {
    const s = settings();
    const fp = fingerprint(msg);
    const idx = s.markedFingerprints.indexOf(fp);
    if (idx === -1) s.markedFingerprints.push(fp);
    else s.markedFingerprints.splice(idx, 1);
    saveSettingsDebounced();
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function templateToRegex(template) {
    const placeholder = "{{content}}";
    const idx = template.indexOf(placeholder);
    if (idx === -1) return null;

    const before = template.slice(0, idx);
    const after = template.slice(idx + placeholder.length);

    const pattern = escapeRegex(before) + "[\\s\\S]*?" + escapeRegex(after);
    return new RegExp(pattern, "g");
}

const LOREBOOK_APP_URL = "http://localhost:5173";

async function fetchClipboardTemplate() {
    try {
        const res = await fetch(`${LOREBOOK_APP_URL}/api/settings`, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) return null;
        const data = await res.json();
        return data.clipboardTemplate || null;
    } catch {
        return null;
    }
}

async function getCompactPattern() {
    const remote = await fetchClipboardTemplate();
    if (remote) {
        settings().compactPattern = remote;
        $("#asweep_compact_pattern").val(remote);
        saveSettingsDebounced();
        return remote;
    }
    return settings().compactPattern || "";
}

function scanCompactWithPattern(template) {
    if (!template || !template.trim()) {
        toastr.error("Compact pattern is empty. Configure it in the Lorebook app or extension settings.");
        return [];
    }

    const regex = templateToRegex(template);
    if (!regex) {
        toastr.error("Compact pattern must contain {{content}} placeholder.");
        return [];
    }

    const chat = getContext().chat || [];
    const results = [];

    chat.forEach((msg, idx) => {
        const text = msg.mes || "";
        const matches = text.match(regex);
        if (matches && matches.length > 0) {
            const stripped = text.replace(regex, "").trim();
            results.push({
                idx,
                msg,
                matches,
                originalText: text,
                strippedText: stripped,
                include: true,
            });
        }
    });

    return results;
}

function patternLines() {
    return settings().pattern
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean);
}

function matchesPattern(text) {
    const lines = patternLines();
    if (lines.length === 0) return false;
    const hay = settings().fuzzy ? text.toLowerCase() : text;
    let hits = 0;
    for (const line of lines) {
        const needle = settings().fuzzy ? line.toLowerCase() : line;
        if (hay.includes(needle)) hits++;
    }
    const ratio = (hits / lines.length) * 100;
    return ratio >= settings().threshold;
}

function scanChat() {
    const chat = getContext().chat || [];
    const patternHits = new Set();
    const markedHits = new Set();
    const s = settings();

    chat.forEach((msg, idx) => {
        const text = msg.mes || "";
        if (matchesPattern(text)) patternHits.add(idx);
        if (s.markedFingerprints.includes(fingerprint(msg))) markedHits.add(idx);
    });

    const allIds = new Set([...patternHits, ...markedHits]);
    return [...allIds].sort((a, b) => a - b).map(idx => {
        const msg = chat[idx];
        const inPattern = patternHits.has(idx);
        const inMarked = markedHits.has(idx);
        const source = inPattern && inMarked ? "both" : inPattern ? "pattern" : "marked";
        return { idx, msg, source, include: true };
    });
}

function renderResults() {
    const $list = $("#asweep_results");
    $list.empty();
    for (const r of lastScan) {
        const sender = r.msg.name || (r.msg.is_user ? "User" : "AI");
        const date = r.msg.send_date || "";
        const text = r.msg.mes || "";
        const snippet = text.replace(/\s+/g, " ").slice(0, 140);
        const full = $("<pre class='asweep-full'></pre>").text(text);
        const tag = $(`<span class='asweep-tag ${r.source}'></span>`).text(r.source.toUpperCase());
        const cb = $(`<input type='checkbox' ${r.include ? "checked" : ""} />`)
            .on("click", e => { e.stopPropagation(); r.include = e.target.checked; updateCount(); });
        const head = $("<div class='asweep-result-head'></div>")
            .append(cb)
            .append($("<span></span>").text(`#${r.idx}`))
            .append(tag)
            .append($("<span></span>").text(sender))
            .append($("<span class='asweep-snippet'></span>").text(snippet))
            .append($("<small></small>").text(date))
            .on("click", e => {
                if (e.target.tagName === "INPUT") return;
                $(e.currentTarget).parent().toggleClass("expanded");
            });
        const row = $("<div class='asweep-result'></div>").append(head).append(full);
        $list.append(row);
    }
    updateCount();
}

function updateCount() {
    const total = lastScan.length;
    const on = lastScan.filter(r => r.include).length;
    $("#asweep_modal_count").text(`(${on} of ${total} selected)`);
}

function openModal() {
    renderResults();
    $("#asweep_modal").show();
}
function closeModal() { $("#asweep_modal").hide(); }

function renderCompactResults() {
    const $list = $("#asweep_compact_results");
    $list.empty();
    for (const r of lastCompactScan) {
        const sender = r.msg.name || (r.msg.is_user ? "User" : "AI");
        const date = r.msg.send_date || "";
        const matchCount = r.matches.length;
        const snippet = r.originalText.replace(/\s+/g, " ").slice(0, 100);
        const isEmpty = !r.strippedText.trim();

        const beforePre = $("<pre class='asweep-compact-before'></pre>").text(r.originalText);
        const afterPre = $("<pre class='asweep-compact-after'></pre>").text(r.strippedText || "(empty)");
        if (isEmpty) afterPre.addClass("asweep-empty-warning");

        const cb = $(`<input type='checkbox' ${r.include ? "checked" : ""} />`)
            .on("click", e => { e.stopPropagation(); r.include = e.target.checked; updateCompactCount(); });

        const head = $("<div class='asweep-result-head'></div>")
            .append(cb)
            .append($("<span></span>").text(`#${r.idx}`))
            .append($("<span class='asweep-tag compact'></span>").text(`${matchCount} match${matchCount > 1 ? "es" : ""}`));

        if (isEmpty) {
            head.append($("<span class='asweep-tag empty-tag'></span>").text("EMPTY"));
        }

        head.append($("<span></span>").text(sender))
            .append($("<span class='asweep-snippet'></span>").text(snippet))
            .append($("<small></small>").text(date))
            .on("click", e => {
                if (e.target.tagName === "INPUT") return;
                $(e.currentTarget).parent().toggleClass("expanded");
            });

        const diffContainer = $("<div class='asweep-compact-diff'></div>")
            .append($("<div class='asweep-diff-label'>Before:</div>"))
            .append(beforePre)
            .append($("<div class='asweep-diff-label'>After:</div>"))
            .append(afterPre);

        const row = $("<div class='asweep-result'></div>").append(head).append(diffContainer);
        $list.append(row);
    }
    updateCompactCount();
}

function updateCompactCount() {
    const total = lastCompactScan.length;
    const on = lastCompactScan.filter(r => r.include).length;
    $("#asweep_compact_modal_count").text(`(${on} of ${total} selected)`);
}

function openCompactModal() {
    renderCompactResults();
    $("#asweep_compact_modal").show();
}
function closeCompactModal() { $("#asweep_compact_modal").hide(); }

function showLoading(message = "Processing...") {
    $("#asweep_loading_text").text(message);
    $("#asweep_loading").show();
}

function hideLoading() {
    $("#asweep_loading").hide();
}

async function clearCopiedFlags() {
    try {
        await fetch(`${LOREBOOK_APP_URL}/api/clear-copied`, {
            method: "POST",
            signal: AbortSignal.timeout(2000),
        });
    } catch {
        // Silent fail — app may not be running
    }
}

async function applyCompact() {
    const chosen = lastCompactScan.filter(r => r.include);
    if (chosen.length === 0) {
        toastr.info("Nothing selected.");
        return;
    }

    closeCompactModal();
    showLoading(`Compacting ${chosen.length} message(s)...`);

    const context = getContext();
    const chat = context.chat;

    for (const r of chosen) {
        const idx = r.idx;
        if (idx < 0 || idx >= chat.length) continue;
        chat[idx].mes = r.strippedText;
    }

    try {
        if (context.saveChat) await context.saveChat();
    } catch (_) {}

    lastCompactScan = [];

    // Clear copied flags in the lorebook app so entries become "available" again
    await clearCopiedFlags();

    try {
        await reloadCurrentChat();
    } catch (_) {
        try { await eventSource.emit(event_types.CHAT_CHANGED); } catch (_) {}
    }

    hideLoading();
    toastr.success(`Compacted ${chosen.length} message(s).`);
}

async function deleteSelected() {
    const chosen = lastScan.filter(r => r.include);
    if (chosen.length === 0) {
        toastr.info("Nothing selected.");
        return;
    }

    closeModal();
    showLoading(`Deleting ${chosen.length} message(s)...`);

    // DESCENDING order — splicing low indices first would shift higher ones.
    const indices = [...new Set(chosen.map(r => r.idx))].sort((a, b) => b - a);
    const context = getContext();
    const chat = context.chat;

    for (const idx of indices) {
        if (idx < 0 || idx >= chat.length) continue;
        chat.splice(idx, 1);
        try { await eventSource.emit(event_types.MESSAGE_DELETED, idx); } catch (_) {}
    }

    // Clear marked list — prevents re-deletion attempts on fingerprints that no longer exist.
    settings().markedFingerprints = [];
    saveSettingsDebounced();

    // Persist chat.
    try {
        if (context.saveChat) await context.saveChat();
    } catch (_) {}

    lastScan = [];

    // Reload the chat so DOM matches the updated chat array cleanly.
    try {
        await reloadCurrentChat();
    } catch (_) {
        try { await eventSource.emit(event_types.CHAT_CHANGED); } catch (_) {}
    }

    hideLoading();
    toastr.success(`Deleted ${indices.length} message(s).`);
}

async function cleanMessages(args, value) {
    const trimmed = (value || "").trim();
    const startIdx = parseInt(trimmed, 10);

    if (isNaN(startIdx) || startIdx < 0) {
        toastr.warning("Usage: /clear N (delete from index N to last - 1)");
        return "";
    }

    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) {
        toastr.warning("No chat loaded.");
        return "";
    }

    const lastIdx = chat.length - 1;

    if (startIdx >= lastIdx) {
        toastr.info("Nothing to delete — start index is at or beyond the last message.");
        return "";
    }

    const endIdx = lastIdx - 1;
    await executeSlashCommands(`/cut ${startIdx}-${endIdx}`);
    return "";
}

function markRange(args, value) {
    const trimmed = (value || "").trim();
    const startIdx = parseInt(trimmed, 10);

    if (isNaN(startIdx) || startIdx < 0) {
        toastr.warning("Usage: /mark N — marks messages from index N to last - 1 (preserves the final message)");
        return "";
    }

    const chat = getContext().chat || [];
    if (chat.length === 0) {
        toastr.warning("No chat loaded.");
        return "";
    }

    const lastIdx = chat.length - 1;
    const endIdx = lastIdx - 1;

    if (startIdx > endIdx) {
        toastr.warning(`Start index ${startIdx} exceeds last - 1 index ${endIdx}.`);
        return "";
    }

    const s = settings();
    let markedCount = 0;

    for (let i = startIdx; i <= endIdx; i++) {
        const msg = chat[i];
        const fp = fingerprint(msg);
        if (!s.markedFingerprints.includes(fp)) {
            s.markedFingerprints.push(fp);
            markedCount++;
        }
    }

    saveSettingsDebounced();
    injectAllMarkButtons();
    toastr.success(`Marked ${markedCount} message(s) from index ${startIdx} to ${endIdx}.`);
    return "";
}

function onScan() {
    // Persist current UI values first.
    settings().pattern = $("#asweep_pattern").val();
    settings().threshold = parseInt($("#asweep_threshold").val(), 10) || 80;
    settings().fuzzy = $("#asweep_fuzzy").prop("checked");
    saveSettingsDebounced();

    lastScan = scanChat();
    $("#asweep_status").text(`Found ${lastScan.length} match(es).`);
    if (lastScan.length === 0) {
        toastr.info("No matching messages.");
        return;
    }
    openModal();
}

async function onCompactScan() {
    $("#asweep_compact_status").text("Fetching pattern...");
    const pattern = await getCompactPattern();

    lastCompactScan = scanCompactWithPattern(pattern);
    if (lastCompactScan.length === 0) {
        $("#asweep_compact_status").text("No matches found.");
        toastr.info("Nothing to compact.");
        return;
    }
    $("#asweep_compact_status").text(`Found ${lastCompactScan.length} message(s) with matches.`);
    openCompactModal();
}

async function compactCommand(args, value) {
    const pattern = await getCompactPattern();
    lastCompactScan = scanCompactWithPattern(pattern);
    if (lastCompactScan.length === 0) {
        toastr.info("Nothing to compact.");
        return "";
    }
    openCompactModal();
    return "";
}

function onClearMarks() {
    settings().markedFingerprints = [];
    saveSettingsDebounced();
    $(".asweep-mark-btn").removeClass("marked");
    toastr.info("Cleared all marked messages.");
}

function injectMarkButton($mes) {
    const mesid = parseInt($mes.attr("mesid"), 10);
    const chat = getContext().chat || [];
    const msg = chat[mesid];
    if (!msg) return;

    const $existing = $mes.find(".asweep-mark-btn");
    if ($existing.length) {
        $existing.toggleClass("marked", isMarked(msg));
        return;
    }

    const $btn = $(`<div class="asweep-mark-btn fa-solid fa-trash-can" title="Mark for analysis-sweep delete"></div>`);
    if (isMarked(msg)) $btn.addClass("marked");
    $btn.on("click", e => {
        e.stopPropagation();
        toggleMark(msg);
        $btn.toggleClass("marked");
    });
    // Put it alongside ST's existing per-message buttons.
    const $buttons = $mes.find(".mes_buttons").first();
    if ($buttons.length) $buttons.prepend($btn);
    else $mes.find(".mes_block, .mes_text").first().prepend($btn);
}

function injectAllMarkButtons() {
    $("#chat .mes").each((_, el) => injectMarkButton($(el)));
}

function observeChat() {
    const target = document.getElementById("chat");
    if (!target) return;
    const obs = new MutationObserver(() => injectAllMarkButtons());
    obs.observe(target, { childList: true, subtree: false });
}

jQuery(async () => {
    // Register slash commands
    registerSlashCommand("clear", cleanMessages, [], "Deletes messages from index N to last - 1, preserving the final message. /clear 30 = delete from index 30");
    registerSlashCommand("mark", markRange, [], "Marks messages from index N to last - 1, preserving the final message. /mark 300 = mark from index 300 to last - 1");
    registerSlashCommand("compact", compactCommand, [], "Scans messages and strips out content matching the compact pattern (e.g., OOC context blocks). Opens a preview before applying.");

    const html = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings").append(html);

    // Modal must live at body level so it renders even when the extension
    // drawer is collapsed (parent would otherwise hide it).
    $("#asweep_modal").detach().appendTo("body");
    $("#asweep_compact_modal").detach().appendTo("body");
    $("#asweep_loading").detach().appendTo("body");

    const s = settings();
    $("#asweep_pattern").val(s.pattern);
    $("#asweep_threshold").val(s.threshold);
    $("#asweep_fuzzy").prop("checked", s.fuzzy);
    $("#asweep_compact_pattern").val(s.compactPattern);

    $("#asweep_pattern").on("input", () => {
        settings().pattern = $("#asweep_pattern").val();
        saveSettingsDebounced();
    });
    $("#asweep_threshold").on("input", () => {
        settings().threshold = parseInt($("#asweep_threshold").val(), 10) || 80;
        saveSettingsDebounced();
    });
    $("#asweep_fuzzy").on("input", () => {
        settings().fuzzy = $("#asweep_fuzzy").prop("checked");
        saveSettingsDebounced();
    });
    $("#asweep_compact_pattern").on("input", () => {
        settings().compactPattern = $("#asweep_compact_pattern").val();
        saveSettingsDebounced();
    });

    $("#asweep_scan").on("click", onScan);
    $("#asweep_clear_marks").on("click", onClearMarks);
    $("#asweep_delete").on("click", deleteSelected);
    $("#asweep_cancel").on("click", closeModal);
    $("#asweep_modal_close").on("click", closeModal);
    $("#asweep_expand_all").on("click", () => $(".asweep-result").addClass("expanded"));
    $("#asweep_collapse_all").on("click", () => $(".asweep-result").removeClass("expanded"));
    $("#asweep_toggle_all").on("click", () => {
        const anyOff = lastScan.some(r => !r.include);
        lastScan.forEach(r => r.include = anyOff);
        renderResults();
    });

    // Compact modal handlers
    $("#asweep_compact_scan").on("click", onCompactScan);
    $("#asweep_compact_apply").on("click", applyCompact);
    $("#asweep_compact_cancel").on("click", closeCompactModal);
    $("#asweep_compact_modal_close").on("click", closeCompactModal);
    $("#asweep_compact_expand_all").on("click", () => $("#asweep_compact_results .asweep-result").addClass("expanded"));
    $("#asweep_compact_collapse_all").on("click", () => $("#asweep_compact_results .asweep-result").removeClass("expanded"));
    $("#asweep_compact_toggle_all").on("click", () => {
        const anyOff = lastCompactScan.some(r => !r.include);
        lastCompactScan.forEach(r => r.include = anyOff);
        renderCompactResults();
    });

    // Floating shortcut buttons — appended to body, anchored to #sheld via JS.
    const $floatingScan = $(`<div id="asweep_floating_scan" class="fa-solid fa-broom" title="Analysis Sweep: Scan"></div>`);
    $floatingScan.on("click", onScan);
    $("body").append($floatingScan);

    const $floatingCompact = $(`<div id="asweep_floating_compact" class="fa-solid fa-compress" title="Compact: Strip OOC context"></div>`);
    $floatingCompact.on("click", onCompactScan);
    $("body").append($floatingCompact);

    const $floatingReload = $(`<div id="asweep_floating_reload" class="fa-solid fa-rotate-right" title="Reload current chat"></div>`);
    $floatingReload.on("click", async () => {
        try { await reloadCurrentChat(); }
        catch (e) { toastr.warning("Reload failed: " + e.message); }
    });
    $("body").append($floatingReload);

    // SSE listener for auto-reloading world info when lorebook app saves
    try {
        const worldInfoSSE = new EventSource(`${LOREBOOK_APP_URL}/api/world-info/stream`);
        worldInfoSSE.addEventListener("world-info-updated", async () => {
            try {
                worldInfoCache.clear();
                await getContext().updateWorldInfoList();
            } catch (_) {}
        });
    } catch (_) {}

    // Sync ST textarea content to lorebook app for live keyword matching
    $("#send_textarea").on("input", () => {
        clearTimeout(textareaDebounce);
        textareaDebounce = setTimeout(() => {
            const content = $("#send_textarea").val();
            fetch(`${LOREBOOK_APP_URL}/api/st-textarea`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content }),
            }).catch(() => {});
        }, 500);
    });

    const STACK_GAP = 12; // px between buttons
    const BTN_SIZE = 36;

    function positionFloatingButtons() {
        const sheld = document.getElementById("sheld");
        let left, top;
        if (sheld) {
            const rect = sheld.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                left = rect.left + 8;
                top = rect.top + rect.height * 0.2;
            }
        }
        if (left === undefined) {
            left = 8;
            top = window.innerHeight * 0.2;
        }
        $floatingScan.css({ left: left + "px", top: top + "px" });
        $floatingCompact.css({ left: left + "px", top: (top + BTN_SIZE + STACK_GAP) + "px" });
        $floatingReload.css({ left: left + "px", top: (top + (BTN_SIZE + STACK_GAP) * 2) + "px" });
    }

    positionFloatingButtons();
    window.addEventListener("resize", positionFloatingButtons);
    // ST may rearrange layout on chat switch / panel toggle — repoll.
    setInterval(positionFloatingButtons, 1000);

    injectAllMarkButtons();
    observeChat();
    // Re-inject when ST swaps chats or sends new messages.
    try {
        eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(injectAllMarkButtons, 200));
        eventSource.on(event_types.MESSAGE_RECEIVED, () => setTimeout(injectAllMarkButtons, 100));
        eventSource.on(event_types.MESSAGE_SENT, () => setTimeout(injectAllMarkButtons, 100));
    } catch (_) {}
});
