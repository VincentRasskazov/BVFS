export function parseCommand(input) {
    const tokens = [];
    let current = '', inQuotes = false, quoteChar = '';

    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        if ((char === '"' || char === "'") && (i === 0 || input[i - 1] !== '\\')) {
            if (inQuotes && quoteChar === char) inQuotes = false;
            else if (!inQuotes) { inQuotes = true; quoteChar = char; }
            else current += char;
        } else if (char === ' ' && !inQuotes) {
            if (current) tokens.push(current);
            current = '';
        } else current += char;
    }
    if (current) tokens.push(current);

    const pipeline = [];
    let cmd = { args: [], redirectOut: null, appendOut: false };

    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] === '|') { pipeline.push(cmd); cmd = { args: [], redirectOut: null, appendOut: false }; }
        else if (tokens[i] === '>') cmd.redirectOut = tokens[++i];
        else if (tokens[i] === '>>') { cmd.appendOut = true; cmd.redirectOut = tokens[++i]; }
        else cmd.args.push(tokens[i]);
    }
    pipeline.push(cmd);
    return pipeline;
}
