export const OTHER_MODEL_COLOR = '#728b93';

const providerPalette = [
    '#6677bd',
    '#548d9b',
    '#9a6e9b',
    '#8b8750',
    '#547caf',
    '#b66b66',
] as const;

const tokenize = (value: string): Set<string> =>
    new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

const hasAny = (tokens: Set<string>, ...values: string[]): boolean => values.some((value) => tokens.has(value));

const stableIndex = (value: string, length: number): number => {
    let hash = 2_166_136_261;
    for (const character of value) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16_777_619);
    }
    return (hash >>> 0) % length;
};

function providerFallback(provider: string): string {
    return providerPalette[stableIndex(provider, providerPalette.length)] ?? OTHER_MODEL_COLOR;
}

export function getModelColor(model: string): string {
    if (model === 'Other models') return OTHER_MODEL_COLOR;

    const segments = model.toLowerCase().split('/');
    const provider = segments[0] ?? model.toLowerCase();
    const tokens = tokenize(model);
    const providerTokens = tokenize(provider);

    if (hasAny(tokens, 'claude', 'anthropic') || hasAny(providerTokens, 'anthropic')) {
        if (tokens.has('opus')) return '#a63d58';
        if (tokens.has('sonnet')) return '#c36918';
        if (tokens.has('haiku')) return '#767f1f';
        return '#b95535';
    }

    if (hasAny(tokens, 'openai', 'gpt', 'chatgpt', 'codex')) {
        if (tokens.has('codex')) return '#21683b';
        if (hasAny(tokens, 'o1', 'o3', 'o4')) return '#3a65a9';
        if (hasAny(tokens, 'dall', 'image')) return '#4b9b79';
        if (hasAny(tokens, 'embedding', 'embed')) return '#798e35';
        return '#087a8b';
    }

    if (hasAny(tokens, 'gemini') || hasAny(providerTokens, 'google', 'gemini')) {
        if (tokens.has('flash')) return tokens.has('lite') ? '#348c80' : '#247bbd';
        return '#6453b1';
    }

    if (hasAny(tokens, 'mistral', 'codestral', 'ministral')) {
        if (tokens.has('codestral')) return '#a35c91';
        if (tokens.has('small') || tokens.has('ministral')) return '#e49349';
        if (tokens.has('large')) return '#d75f4c';
        return '#d77558';
    }

    if (hasAny(tokens, 'deepseek')) {
        if (tokens.has('r1')) return '#367db8';
        if (tokens.has('v3')) return '#2a9d91';
        return '#3289a8';
    }

    if (hasAny(tokens, 'llama', 'meta')) return '#8263b5';
    if (hasAny(tokens, 'grok', 'xai')) return '#5e7293';
    if (hasAny(tokens, 'cohere', 'command')) return '#7861aa';
    if (hasAny(tokens, 'qwen', 'alibaba')) return '#b65f89';
    if (hasAny(tokens, 'nova') || hasAny(providerTokens, 'amazon', 'bedrock')) return '#c48736';

    return providerFallback(provider);
}
