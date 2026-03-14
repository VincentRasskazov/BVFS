// ==========================================
// 1. STATE & ENVIRONMENT
// ==========================================
export const ENV = { USER: 'guest', HOME: '/home/guest', PWD: '/home/guest', PATH: '/bin' };
let mounts = {}; // Format: { '/mnt/local': FileSystemDirectoryHandle }
let history = JSON.parse(localStorage.getItem('bvfs_hist') || '[]');
let histCursor = history.length;

// ==========================================
// 2. PATH & VFS ROUTER
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
    return ['/' + parts.join('/'), name || '/'];
}

// Find the deepest mount point for a given path
function resolveMount(path) {
    let bestMatch = '/';
    for (let m in mounts) {
        if (path.startsWith(m) && m.length > bestMatch.length) bestMatch = m;
    }
    let relPath = path.slice(bestMatch.length).split('/').filter(Boolean).join('/');
    return { rootHandle: mounts[bestMatch], relPath };
}

async function initVFS() {
    const opfsRoot = await navigator.storage.getDirectory();
    mounts['/'] = opfsRoot; // Root is OPFS
    for (const d of ['home', 'tmp', 'bin', 'mnt']) await opfsRoot.getDirectoryHandle(d, { create: true });
    const home = await opfsRoot.getDirectoryHandle('home');
    await home.getDirectoryHandle('guest', { create: true });
}

async function getHandle(path, create = false, isFile = false) {
    let { rootHandle, relPath } = resolveMount(path);
    if (!relPath) return rootHandle;
    let curr = rootHandle, parts = relPath.split('/').filter(Boolean);
    
    for (let i = 0; i < parts.length; i++) {
        let isLast = i === parts.length - 1;
        if (isLast && isFile) return await curr.getFileHandle(parts[i], { create });
        curr = await curr.getDirectoryHandle(parts[i], { create: (isLast ? create : false) });
    }
    return curr;
}

// ==========================================
// 3. WASM RUNTIME ENGINE
// ==========================================
async function runWasm(handle, args, io) {
    try {
        const file = await handle.getFile();
        const buffer = await file.arrayBuffer();
        
        // Basic WASI/Env mock for the WebAssembly module
        const env = {
            print: (ptr, len) => { // Simple stdout hook
                const view = new Uint8Array(memory.buffer, ptr, len);
                io.stdout(new TextDecoder().decode(view));
            }
        };

        let memory;
        const { instance } = await WebAssembly.instantiate(buffer, { env, wasi_snapshot_preview1: env });
        memory = instance.exports.memory;
        
        if (instance.exports._start) {
            instance.exports._start(); // Execute main
            io.stdout('\n');
        } else {
            io.stderr("wasm: no _start exported\n");
        }
    } catch (e) {
        io.stderr(`wasm exec error: ${e.message}\n`);
    }
}

// ==========================================
// 4. PARSER & COMMANDS
// ==========================================
function expandEnv(str) {
    return str.replace(/\$(\w+)/g, (_, key) => ENV[key] !== undefined ? ENV[key] : '');
}

function parseCommand(input) {
    const tokens = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    let pipeline = [], cmd = { args: [], redirectOut: null, append: false };
    for (let i = 0; i < tokens.length; i++) {
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
    help: async (args, io) => io.stdout(`Commands:\n  ${Object.keys(commands).sort().join('\n  ')}\n`),
    pwd: async (args, io) => io.stdout(ENV.PWD + '\n'),
    clear: async (args, io) => io.clear(),
    echo: async (args, io) => io.stdout(args.join(' ') + '\n'),
    whoami: async (args, io) => io.stdout(ENV.USER + '\n'),
    date: async (args, io) => io.stdout(new Date().toString() + '\n'),
    sleep: async (args, io) => new Promise(r => setTimeout(r, (parseFloat(args[0]) || 1) * 1000)),
    history: async (args, io) => io.stdout(history.map((c, i) => `  ${i + 1}  ${c}`).join('\n') + '\n'),
    env: async (args, io) => io.stdout(Object.entries(ENV).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'),
    
    export: async (args, io) => {
        args.forEach(arg => { let [k, v] = arg.split('='); if (k && v !== undefined) ENV[k] = v; });
    },
    
    cd: async (args, io) => {
        const target = resolvePath(args[0] || ENV.HOME);
        try { await getHandle(target); ENV.PWD = target; } catch { io.stderr(`cd: ${args[0]}: No such directory\n`); }
    },
    
    ls: async (args, io) => {
        try {
            const dir = await getHandle(resolvePath(args[0] || '.'));
            let out = [];
            for await (const [name, handle] of dir.entries()) out.push(handle.kind === 'directory' ? `${name}/` : name);
            if (out.length) io.stdout(out.join('  ') + '\n');
        } catch { io.stderr(`ls: cannot access\n`); }
    },
    
    cat: async (args, io) => {
        if (!args.length && io.stdin) return io.stdout(io.stdin);
        for (let f of args) {
            try {
                const h = await getHandle(resolvePath(f), false, true);
                io.stdout(await (await h.getFile()).text() + '\n');
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
            const destHandle = await getHandle(resolvePath(args[1]), true, true);
            const writable = await destHandle.createWritable();
            await writable.write(await (await srcHandle.getFile()).text());
            await writable.close();
        } catch { io.stderr(`cp: error copying file\n`); }
    },

    mv: async (args, io) => {
        if (args.length < 2) return io.stderr("mv: missing operand\n");
        try { await commands.cp([args[0], args[1]], io); await commands.rm([args[0]], io); } 
        catch { io.stderr(`mv: error moving file\n`); }
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

    find: async (args, io) => {
        const target = resolvePath(args[0] || '.');
        async function walk(dirPath, handle) {
            io.stdout(dirPath + '\n');
            for await (const [name, childHandle] of handle.entries()) {
                const childPath = dirPath === '/' ? `/${name}` : `${dirPath}/${name}`;
                if (childHandle.kind === 'directory') await walk(childPath, childHandle);
                else io.stdout(childPath + '\n');
            }
        }
        try { await walk(target, await getHandle(target)); } catch { io.stderr(`find: ${target}: No such file or directory\n`); }
    },

    df: async (args, io) => {
        io.stdout("Filesystem    Mounted on\n");
        for (let m in mounts) io.stdout(`${m === '/' ? 'OPFS' : 'LocalDir'}       ${m}\n`);
    },

    // --- MOUNT SYSTEM ---
    mount: async (args, io) => {
        if (args.length === 0) return await commands.df([], io);
        if (args[0] === 'local') {
            const target = resolvePath(args[1] || '/mnt/local');
            try {
                // Request OS directory access from the user
                const dirHandle = await window.showDirectoryPicker();
                mounts[target] = dirHandle;
                // Ensure the mount point exists in the parent VFS visually
                await commands.mkdir([target], { stderr: () => {} }); 
                io.stdout(`Mounted local directory to ${target}\n`);
            } catch (e) { io.stderr(`mount: User aborted or failed to mount local directory\n`); }
        } else {
            io.stderr(`mount: unknown fs type ${args[0]}. Try: mount local /mnt/local\n`);
        }
    },

    umount: async (args, io) => {
        if (!args[0]) return io.stderr("umount: missing operand\n");
        const target = resolvePath(args[0]);
        if (target === '/') return io.stderr("umount: cannot unmount root\n");
        if (mounts[target]) { delete mounts[target]; io.stdout(`Unmounted ${target}\n`); } 
        else { io.stderr(`umount: ${target}: not mounted\n`); }
    }
};

// ==========================================
// 5. SHELL ENGINE UI & EXECUTION
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
        
        let currOut = '';
        const io = { stdin: prevOut, stdout: (t) => currOut += t, stderr: (t) => print(t, true), clear: () => ui.out.innerHTML = '' };
        
        if (commands[name]) {
            await commands[name](cmdObj.args, io);
        } else {
            // WASM Fallback Execution
            try {
                const targetPath = resolvePath(name.endsWith('.wasm') ? name : `${name}.wasm`);
                const handle = await getHandle(targetPath, false, true);
                await runWasm(handle, cmdObj.args, io);
            } catch {
                print(`bvfs: ${name}: command not found\n`, true); break;
            }
        }

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
    print("BVFS Micro-Kernel v3.0 initializing...\n");
    try { await initVFS(); print("OPFS Mounted. VFS Router Active. WASM Runtime Ready.\n\n"); } 
    catch (e) { print(`VFS Error: ${e.message}\n`, true); }
    
    ui.prompt.innerText = `${ENV.USER}@bvfs:${ENV.PWD}$ `;
    
    ui.in.addEventListener('keydown', async (e) => {
        if (e.key === 'ArrowUp') { e.preventDefault(); if (histCursor > 0) ui.in.value = history[--histCursor] || ''; return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); if (histCursor < history.length - 1) ui.in.value = history[++histCursor]; else { histCursor = history.length; ui.in.value = ''; } return; }
        if (e.key !== 'Enter') return;
        
        const val = ui.in.value; ui.in.value = '';
        await execute(val);
        ui.prompt.innerText = `${ENV.USER}@bvfs:${ENV.PWD}$ `;
    });
    
    document.addEventListener('click', () => ui.in.focus());
};
