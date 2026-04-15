import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, reloadCurrentChat } from "../../../../script.js";

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
};

let lastScan = [];

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

async function deleteSelected() {
    const chosen = lastScan.filter(r => r.include);
    if (chosen.length === 0) {
        toastr.info("Nothing selected.");
        return;
    }

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

    closeModal();
    lastScan = [];

    // Reload the chat so DOM matches the updated chat array cleanly.
    try {
        await reloadCurrentChat();
    } catch (_) {
        try { await eventSource.emit(event_types.CHAT_CHANGED); } catch (_) {}
    }

    toastr.success(`Deleted ${indices.length} message(s).`);
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

function onClearMarks() {
    settings().markedFingerprints = [];
    saveSettingsDebounced();
    $(".asweep-mark-btn").removeClass("marked");
    toastr.info("Cleared all marked messages.");
}

function injectMarkButton($mes) {
    if ($mes.find(".asweep-mark-btn").length) return;
    const mesid = parseInt($mes.attr("mesid"), 10);
    const chat = getContext().chat || [];
    const msg = chat[mesid];
    if (!msg) return;
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
    const html = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings").append(html);

    // Modal must live at body level so it renders even when the extension
    // drawer is collapsed (parent would otherwise hide it).
    $("#asweep_modal").detach().appendTo("body");

    const s = settings();
    $("#asweep_pattern").val(s.pattern);
    $("#asweep_threshold").val(s.threshold);
    $("#asweep_fuzzy").prop("checked", s.fuzzy);

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

    // Floating scan shortcut — appended to body, positioned at middle-left of #sheld via JS.
    const $floatingScan = $(`<div id="asweep_floating_scan" class="fa-solid fa-broom" title="Analysis Sweep: Scan"></div>`);
    $floatingScan.on("click", onScan);
    $("body").append($floatingScan);

    function positionFloatingScan() {
        const sheld = document.getElementById("sheld");
        if (sheld) {
            const rect = sheld.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                $floatingScan.css({
                    left: (rect.left + 8) + "px",
                    top: (rect.top + rect.height * 0.4) + "px",
                });
                return;
            }
        }
        // Fallback: 40% down from top, left-aligned, so the user can still see it.
        $floatingScan.css({ left: "8px", top: "40%" });
    }

    positionFloatingScan();
    window.addEventListener("resize", positionFloatingScan);
    // ST may rearrange layout on chat switch / panel toggle — repoll.
    setInterval(positionFloatingScan, 1000);

    injectAllMarkButtons();
    observeChat();
    // Re-inject when ST swaps chats or sends new messages.
    try {
        eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(injectAllMarkButtons, 200));
        eventSource.on(event_types.MESSAGE_RECEIVED, () => setTimeout(injectAllMarkButtons, 100));
        eventSource.on(event_types.MESSAGE_SENT, () => setTimeout(injectAllMarkButtons, 100));
    } catch (_) {}
});
