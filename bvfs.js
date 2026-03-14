// ==========================================
// 1. STATE & ENVIRONMENT
// ==========================================
export const ENV = { USER: 'guest', HOME: '/home/guest', PWD: '/home/guest', PATH: '/bin' };
let opfsRoot;
let history = JSON.parse(localStorage.getItem('bvfs_hist') || '[]');
let histCursor = history.length;

// ==========================================
// 2. PATH & VFS (Origin Private File System)
// ==========================================
function resolvePath(target) {
    if (!target) return ENV.PWD;
    let base = target.startsWith('/') ? '/' : ENV.PWD;
    let parts = (base === '/' ? [] : base.split('/').filter(Boolean)).concat(target.split('/').filter(Boolean));
    let resolved = [];
    for (let p of parts) {
        if (p === '.') continue;
        if (p === '..') resolved.pop();
        else resolved.push(p);
    }
    return '/' + resolved.join('/');
}

function splitPath(p) {
    let parts = p.split('/').filter(Boolean);
    let name = parts.pop();
    return ['/' + parts.join('/'), name];
}

async function initVFS() {
    opfsRoot = await navigator.storage.getDirectory();
    for (const d of ['home', 'tmp', 'bin']) await opfsRoot.getDirectoryHandle(d, { create: true });
    const home = await opfsRoot.getDirectoryHandle('home');
    await home.getDirectoryHandle('guest', { create: true });
}

async function getHandle(path, create = false, isFile = false) {
    if (path === '/') return opfsRoot;
    let curr = opfsRoot, parts = path.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
        let isLast = i === parts.length - 1;
        if (isLast && isFile) return await curr.getFileHandle(parts[i], { create });
        curr = await curr.getDirectoryHandle(parts[i], { create: (isLast ? create : false) });
    }
    return curr;
}

// ==========================================
// 3. PARSER & COMMANDS
// ==========================================
function expandEnv(str) {
    return str.replace(/\$(\w+)/g, (_, key) => ENV[key] !== undefined ? ENV[key] : '');
}

function parseCommand(input) {
    const tokens = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    let pipeline = [], cmd = { args: [], redirectOut: null, append: false };
    for (let i = 0; i < tokens.length; i++) {
        // Strip quotes and expand variables if not in single quotes
        let isSingleQuote = tokens[i].startsWith("'");
        let t = tokens[i].replace(/^["']|["']$/g, '');
        if (!isSingleQuote) t = expandEnv(t);

        if (t === '|') { pipeline.push(cmd); cmd = { args: [], redirectOut: null, append: false }; }
        else if (t === '>') cmd.redirectOut = expandEnv(tokens[++i].replace(/^["']|["']$/g, ''));
        else if (t === '>>') { cmd.append = true; cmd.redirectOut = expandEnv(tokens[++i].replace(/^["']|["']$/g, '')); }
        else cmd.args.push(t);
    }
    pipeline.push(cmd);
    return pipeline;
}

const commands = {
    help: async (args, io) => io.stdout(`Available commands:\n  ${Object.keys(commands).sort().join('\n  ')}\n`),
    pwd: async (args, io) => io.stdout(ENV.PWD + '\n'),
    clear: async (args, io) => io.clear(),
    echo: async (args, io) => io.stdout(args.join(' ') + '\n'),
    whoami: async (args, io) => io.stdout(ENV.USER + '\n'),
    date: async (args, io) => io.stdout(new Date().toString() + '\n'),
    history: async (args, io) => io.stdout(history.map((c, i) => `  ${i + 1}  ${c}`).join('\n') + '\n'),
    env: async (args, io) => io.stdout(Object.entries(ENV).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'),
    
    export: async (args, io) => {
        args.forEach(arg => {
            let [k, v] = arg.split('=');
            if (k && v !== undefined) ENV[k] = v;
        });
    },
    
    cd: async (args, io) => {
        const target = resolvePath(args[0] || ENV.HOME);
        try { await getHandle(target); ENV.PWD = target; } catch { io.stderr(`cd: ${args[0]}: No such directory\n`); }
    },
    
    ls: async (args, io) => {
        try {
            const dir = await getHandle(resolvePath(args[0] || '.'));
            let out = [];
            for await (const [name, handle] of dir.entries()) out.push(handle.kind === 'directory' ? `\x1b[1;34m${name}/\x1b[0m` : name);
            // Quick ANSI strip for basic UI, or keep for future ANSI renderer
            if (out.length) io.stdout(out.map(s => s.replace(/\x1b\[[0-9;]*m/g, '')).join('  ') + '\n');
        } catch { io.stderr(`ls: cannot access\n`); }
    },
    
    cat: async (args, io) => {
        if (!args.length && io.stdin) return io.stdout(io.stdin);
        for (let f of args) {
            try {
                const h = await getHandle(resolvePath(f), false, true);
                let text = await (await h.getFile()).text();
                io.stdout(text + (text.endsWith('\n') ? '' : '\n'));
            } catch { io.stderr(`cat: ${f}: No such file\n`); }
        }
    },

    mkdir: async (args, io) => {
        if (!args[0]) return io.stderr("mkdir: missing operand\n");
        try { await getHandle(resolvePath(args[0]), true, false); } catch { io.stderr(`mkdir: error creating ${args[0]}\n`); }
    },

    touch: async (args, io) => {
        if (!args[0]) return io.stderr("touch: missing operand\n");
        try { await getHandle(resolvePath(args[0]), true, true); } catch { io.stderr(`touch: error touching ${args[0]}\n`); }
    },

    rm: async (args, io) => {
        if (!args[0]) return io.stderr("rm: missing operand\n");
        const target = resolvePath(args[0]);
        if (target === '/') return io.stderr("rm: permission denied\n");
        const [parentDir, name] = splitPath(target);
        try {
            const parentHandle = await getHandle(parentDir);
            await parentHandle.removeEntry(name, { recursive: true });
        } catch { io.stderr(`rm: cannot remove '${args[0]}': No such file or directory\n`); }
    },

    cp: async (args, io) => {
        if (args.length < 2) return io.stderr("cp: missing file operand\n");
        try {
            const srcHandle = await getHandle(resolvePath(args[0]), false, true);
            const text = await (await srcHandle.getFile()).text();
            const destHandle = await getHandle(resolvePath(args[1]), true, true);
            const writable = await destHandle.createWritable();
            await writable.write(text);
            await writable.close();
        } catch { io.stderr(`cp: cannot stat '${args[0]}': No such file\n`); }
    },

    mv: async (args, io) => {
        if (args.length < 2) return io.stderr("mv: missing file operand\n");
        try {
            await commands.cp([args[0], args[1]], io);
            await commands.rm([args[0]], io);
        } catch { io.stderr(`mv: error moving file\n`); }
    },

    grep: async (args, io) => {
        if (!args[0]) return io.stderr("grep: missing pattern\n");
        const regex = new RegExp(args[0]);
        const processStr = (str) => {
            const matches = str.split('\n').filter(l => regex.test(l));
            if (matches.length) io.stdout(matches.join('\n') + '\n');
        };
        if (io.stdin) return processStr(io.stdin);
        if (!args[1]) return io.stderr("grep: missing file operand\n");
        try {
            const h = await getHandle(resolvePath(args[1]), false, true);
            processStr(await (await h.getFile()).text());
        } catch { io.stderr(`grep: ${args[1]}: No such file\n`); }
    },

    wc: async (args, io) => {
        const processStr = (str, name = '') => {
            const lines = str.split('\n').length - (str.endsWith('\n') ? 1 : 0);
            const words = str.split(/\s+/).filter(Boolean).length;
            const bytes = new Blob([str]).size;
            io.stdout(` ${lines} ${words} ${bytes} ${name}\n`);
        };
        if (io.stdin) return processStr(io.stdin);
        if (!args[0]) return;
        try {
            const h = await getHandle(resolvePath(args[0]), false, true);
            processStr(await (await h.getFile()).text(), args[0]);
        } catch { io.stderr(`wc: ${args[0]}: No such file\n`); }
    }
};

// ==========================================
// 4. SHELL RUNTIME
// ==========================================
const ui = { out: document.getElementById('output'), in: document.getElementById('cmd-input'), prompt: document.getElementById('prompt') };

function print(text, isErr = false) {
    const span = document.createElement('span');
    if (isErr) span.className = 'out-err';
    span.innerText = text;
    ui.out.appendChild(span);
    ui.out.scrollTop = ui.out.scrollHeight;
}

async function execute(input) {
    print(`${ui.prompt.innerText}${input}\n`);
    if (!input.trim()) return;

    if (history[history.length - 1] !== input) {
        history.push(input);
        if (history.length > 500) history.shift();
        localStorage.setItem('bvfs_hist', JSON.stringify(history));
    }
    histCursor = history.length;

    let prevOut = null;
    let pipeline = parseCommand(input);
    
    for (let i = 0; i < pipeline.length; i++) {
        let cmdObj = pipeline[i];
        let name = cmdObj.args.shift();
        if (!commands[name]) { print(`bvfs: ${name}: command not found\n`, true); break; }

        let currOut = '';
        const io = { stdin: prevOut, stdout: (t) => currOut += t, stderr: (t) => print(t, true), clear: () => ui.out.innerHTML = '' };
        
        await commands[name](cmdObj.args, io);

        if (cmdObj.redirectOut) {
            try {
                const handle = await getHandle(resolvePath(cmdObj.redirectOut), true, true);
                const writable = await handle.createWritable({ keepExistingData: cmdObj.append });
                if (cmdObj.append) await writable.seek((await handle.getFile()).size);
                await writable.write(currOut);
                await writable.close();
            } catch { print(`bvfs: error redirecting to ${cmdObj.redirectOut}\n`, true); }
            prevOut = null;
        } else {
            prevOut = currOut;
        }
    }
    if (prevOut && !pipeline[pipeline.length - 1].redirectOut) print(prevOut);
}

window.onload = async () => {
    print("BVFS Micro-Kernel v2.2 initializing...\n");
    try { await initVFS(); print("OPFS Mounted. Type 'help' to see commands.\n\n"); } catch (e) { print(`VFS Error: ${e.message}\n`, true); }
    
    ui.prompt.innerText = `${ENV.USER}@bvfs:${ENV.PWD}$ `;
    
    ui.in.addEventListener('keydown', async (e) => {
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (histCursor > 0) ui.in.value = history[--histCursor] || '';
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (histCursor < history.length - 1) ui.in.value = history[++histCursor];
            else { histCursor = history.length; ui.in.value = ''; }
            return;
        }
        if (e.key !== 'Enter') return;
        
        const val = ui.in.value; 
        ui.in.value = '';
        await execute(val);
        ui.prompt.innerText = `${ENV.USER}@bvfs:${ENV.PWD}$ `;
    });
    
    document.addEventListener('click', () => ui.in.focus());
};
