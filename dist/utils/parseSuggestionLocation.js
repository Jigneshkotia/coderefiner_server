function normalizeFilePath(filePath) {
    return filePath.trim().replace(/\\/g, '/');
}
export function parseSuggestionLocation(location) {
    const trimmed = location.trim();
    if (!trimmed || /^https?:\/\//i.test(trimmed)) {
        return null;
    }
    if (trimmed.includes(' ')) {
        return null;
    }
    const normalized = trimmed.replace(/\\/g, '/');
    const rangeMatch = normalized.match(/^(.+):(\d+)\s*[,\-]\s*(\d+)$/);
    if (rangeMatch) {
        const filePath = normalizeFilePath(rangeMatch[1]);
        const line = Number.parseInt(rangeMatch[2], 10);
        if (filePath && line > 0) {
            return { filePath, line };
        }
    }
    const lineMatch = normalized.match(/^(.+):(\d+)$/);
    if (lineMatch) {
        const filePath = normalizeFilePath(lineMatch[1]);
        const line = Number.parseInt(lineMatch[2], 10);
        if (filePath && line > 0) {
            return { filePath, line };
        }
    }
    return { filePath: normalized };
}
export function suggestionFilePath(location, filePath) {
    if (filePath?.trim()) {
        return normalizeFilePath(filePath);
    }
    return parseSuggestionLocation(location)?.filePath;
}
export function normalizeRepoFilePath(p) {
    const normalized = p.replace(/\\/g, '/').replace(/^\.\//, '') || '.';
    if (normalized === '.' || /^https?:\/\//i.test(normalized)) {
        return normalized;
    }
    const parsed = parseSuggestionLocation(normalized);
    if (parsed?.filePath && parsed.filePath !== normalized) {
        return parsed.filePath;
    }
    return normalized;
}
