// ==========================================
// 1. STATE & ENVIRONMENT
// ==========================================
export const ENV = { USER: 'guest', HOME: '/home/guest', PWD: '/home/guest', PATH: '/bin' };
let mounts = {}; 
let history = JSON.parse(localStorage.getItem('bvfs_hist') || '[]');
let aliases = JSON.parse(localStorage.getItem('bvfs_aliases') || '{}');
let histCursor = history.length;
let jobs = [];
let jobIdCounter = 1;

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

function resolveMount(path) {
    let bestMatch = '/';
    for (let m in mounts) {
        if (path.startsWith(m) && m.length > bestMatch.length) bestMatch = m;
    }
    let relPath = path.slice(bestMatch.length).split('/').filter(Boolean).join('/');
    return { rootHandle: mounts[bestMatch], relPath, mountPoint: bestMatch };
}

async function initVFS() {
    const opfsRoot = await navigator.storage.getDirectory();
    mounts['/'] = opfsRoot;
    for (const d of ['home', 'tmp', 'bin', 'mnt', 'etc']) await opfsRoot.getDirectoryHandle(d, { create: true });
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
        const env = { print: (ptr, len) => { io.stdout(new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len))); } };
        let memory;
        const { instance } = await WebAssembly.instantiate(buffer, { env, wasi_snapshot_preview1: env });
        memory = instance.exports.memory;
        if (instance.exports._start) { instance.exports._start(); io.stdout('\n'); } 
        else { io.stderr("wasm: no _start exported\n"); }
    } catch (e) { io.stderr(`wasm exec error: ${e.message}\n`); }
}

// ==========================================
// 4. PARSER
// ==========================================
function expandEnv(str) { return str.replace(/\$(\w+)/g, (_, key) => ENV[key] !== undefined ? ENV[key] : ''); }

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

// ==========================================
// 5. COMMAND REGISTRY
// ==========================================
const commands = {
    help: async (args, io) => io.stdout(`Commands:\n  ${Object.keys(commands).sort().join(', ')}\n`),
    pwd: async (args, io) => io.stdout(ENV.PWD + '\n'),
    clear: async (args, io) => io.clear(),
    echo: async (args, io) => io.stdout(args.join(' ') + '\n'),
    whoami: async (args, io) => io.stdout(ENV.USER + '\n'),
    date: async (args, io) => io.stdout(new Date().toString() + '\n'),
    sleep: async (args, io) => new Promise(r => setTimeout(r, (parseFloat(args[0]) || 1) * 1000)),
    history: async (args, io) => io.stdout(history.map((c, i) => `  ${i + 1}  ${c}`).join('\n') + '\n'),
    env: async (args, io) => io.stdout(Object.entries(ENV).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'),
    
    export: async (args, io) => { args.forEach(arg => { let [k, v] = arg.split('='); if (k && v !== undefined) ENV[k] = v; }); },
    
    alias: async (args, io) => {
        if (!args.length) return io.stdout(Object.entries(aliases).map(([k, v]) => `alias ${k}='${v}'`).join('\n') + '\n');
        let [k, ...v] = args[0].split('=');
        if (v.length) { aliases[k] = v.join('=').replace(/^['"]|['"]$/g, ''); localStorage.setItem('bvfs_aliases', JSON.stringify(aliases)); }
    },
    unalias: async (args, io) => { if (aliases[args[0]]) { delete aliases[args[0]]; localStorage.setItem('bvfs_aliases', JSON.stringify(aliases)); } },
    
    jobs: async (args, io) => { io.stdout(jobs.map(j => `[${j.id}] ${j.status}  ${j.cmd}`).join('\n') + (jobs.length ? '\n' : '')); },
    
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
    
    stat: async (args, io) => {
        if (!args[0]) return io.stderr("stat: missing operand\n");
        try {
            const h = await getHandle(resolvePath(args[0]), false, true);
            const f = await h.getFile();
            io.stdout(`  File: ${f.name}\n  Size: ${f.size} bytes\n  Last Modified: ${new Date(f.lastModified).toISOString()}\n  Type: ${f.type || 'text/plain'}\n`);
        } catch { io.stderr(`stat: cannot stat '${args[0]}'\n`); }
    },

    cat: async (args, io) => {
        if (!args.length && io.stdin) return io.stdout(io.stdin);
        for (let f of args) {
            try { io.stdout(await (await (await getHandle(resolvePath(f), false, true)).getFile()).text() + '\n'); } 
            catch { io.stderr(`cat: ${f}: No such file\n`); }
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
        try { await (await getHandle(parentDir)).removeEntry(name, { recursive: true }); } 
        catch { io.stderr(`rm: cannot remove '${args[0]}'\n`); }
    },

    cp: async (args, io) => {
        if (args.length < 2) return io.stderr("cp: missing file operand\n");
        try {
            const src = await (await (await getHandle(resolvePath(args[0]), false, true)).getFile()).text();
            const w = await (await getHandle(resolvePath(args[1]), true, true)).createWritable();
            await w.write(src); await w.close();
        } catch { io.stderr(`cp: error copying file\n`); }
    },

    mv: async (args, io) => {
        if (args.length < 2) return io.stderr("mv: missing operand\n");
        try { await commands.cp([args[0], args[1]], io); await commands.rm([args[0]], io); } catch { io.stderr(`mv: error moving\n`); }
    },

    // Text tools
    grep: async (args, io) => {
        if (!args[0]) return io.stderr("grep: missing pattern\n");
        const r = new RegExp(args[0]);
        const p = (str) => { const m = str.split('\n').filter(l => r.test(l)); if (m.length) io.stdout(m.join('\n') + '\n'); };
        if (io.stdin) return p(io.stdin);
        try { p(await (await (await getHandle(resolvePath(args[1]), false, true)).getFile()).text()); } catch { io.stderr(`grep: error\n`); }
    },

    sort: async (args, io) => {
        const p = (str) => io.stdout(str.split('\n').sort().join('\n') + '\n');
        if (io.stdin) return p(io.stdin);
        if (args[0]) p(await (await (await getHandle(resolvePath(args[0]), false, true)).getFile()).text());
    },

    uniq: async (args, io) => {
        const p = (str) => io.stdout(str.split('\n').filter((l, i, a) => i === 0 || l !== a[i-1]).join('\n') + '\n');
        if (io.stdin) return p(io.stdin);
        if (args[0]) p(await (await (await getHandle(resolvePath(args[0]), false, true)).getFile()).text());
    },

    tr: async (args, io) => {
        if (args.length < 2) return io.stderr("tr: missing operands\n");
        const p = (str) => io.stdout(str.split(args[0]).join(args[1]) + (str.endsWith('\n') ? '' : '\n'));
        if (io.stdin) return p(io.stdin);
    },

    base64: async (args, io) => {
        const decode = args.includes('-d');
        const p = (str) => io.stdout((decode ? atob(str.trim()) : btoa(str)) + '\n');
        if (io.stdin) return p(io.stdin);
        const file = args.find(a => a !== '-d');
        if (file) p(await (await (await getHandle(resolvePath(file), false, true)).getFile()).text());
    },

    xxd: async (args, io) => {
        if (!args[0]) return io.stderr("xxd: missing file\n");
        try {
            const buf = await (await (await getHandle(resolvePath(args[0]), false, true)).getFile()).arrayBuffer();
            const arr = new Uint8Array(buf);
            let out = '';
            for (let i = 0; i < arr.length; i += 16) {
                out += i.toString(16).padStart(8, '0') + ': ';
                let hex = [], ascii = '';
                for (let j = 0; j < 16; j++) {
                    if (i + j < arr.length) {
                        let b = arr[i + j];
                        hex.push(b.toString(16).padStart(2, '0'));
                        ascii += (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.';
                    } else { hex.push('  '); }
                    if (j % 2 !== 0) hex[hex.length - 1] += ' ';
                }
                out += hex.join('') + '  ' + ascii + '\n';
            }
            io.stdout(out);
        } catch { io.stderr("xxd: error reading file\n"); }
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
        try { await walk(target, await getHandle(target)); } catch { io.stderr(`find: No such directory\n`); }
    },

    df: async (args, io) => {
        io.stdout("Filesystem    Mounted on\n");
        for (let m in mounts) io.stdout(`${m === '/' ? 'OPFS' : 'LocalDir'}       ${m}\n`);
    },

    mount: async (args, io) => {
        if (args.length === 0) return await commands.df([], io);
        if (args[0] === 'local') {
            const target = resolvePath(args[1] || '/mnt/local');
            try {
                const dirHandle = await window.showDirectoryPicker();
                mounts[target] = dirHandle;
                await commands.mkdir([target], { stderr: () => {} }); 
                io.stdout(`Mounted local directory to ${target}\n`);
            } catch (e) { io.stderr(`mount: User aborted\n`); }
        }
    },

    umount: async (args, io) => {
        if (!args[0]) return io.stderr("umount: missing operand\n");
        const target = resolvePath(args[0]);
        if (target === '/') return io.stderr("umount: cannot unmount root\n");
        if (mounts[target]) { delete mounts[target]; io.stdout(`Unmounted ${target}\n`); } 
        else { io.stderr(`umount: not mounted\n`); }
    },

    sh: async (args, io) => {
        if (!args[0]) return io.stderr("sh: missing script file\n");
        try {
            const script = await (await (await getHandle(resolvePath(args[0]), false, true)).getFile()).text();
            const lines = script.split('\n');
            for (let line of lines) {
                line = line.trim();
                if (line && !line.startsWith('#')) await executeInternal(line, true);
            }
        } catch { io.stderr(`sh: ${args[0]}: No such file\n`); }
    }
};

// ==========================================
// 6. SHELL ENGINE UI & EXECUTION
// ==========================================
const ui = { out: document.getElementById('output'), in: document.getElementById('cmd-input'), prompt: document.getElementById('prompt') };

function print(text, isErr = false) {
    const span = document.createElement('span');
    if (isErr) span.className = 'out-err';
    span.innerText = text;
    ui.out.appendChild(span);
    ui.out.scrollTop = ui.out.scrollHeight;
}

async function executeInternal(input, silentPrompt = false) {
    if (!silentPrompt) print(`${ui.prompt.innerText}${input}\n`);
    if (!input.trim()) return;

    // Background job handling
    const isBackground = input.trim().endsWith('&');
    if (isBackground) input = input.replace(/&\s*$/, '');

    const execLogic = async () => {
        let prevOut = null;
        let pipeline = parseCommand(input);
        
        for (let i = 0; i < pipeline.length; i++) {
            let cmdObj = pipeline[i];
            let name = cmdObj.args.shift();
            
            // Resolve Alias
            if (aliases[name]) {
                const aliasTokens = parseCommand(aliases[name])[0].args;
                name = aliasTokens.shift();
                cmdObj.args = [...aliasTokens, ...cmdObj.args];
            }

            let currOut = '';
            const io = { stdin: prevOut, stdout: (t) => currOut += t, stderr: (t) => print(t, true), clear: () => ui.out.innerHTML = '' };
            
            if (commands[name]) {
                await commands[name](cmdObj.args, io);
            } else {
                try {
                    const handle = await getHandle(resolvePath(name.endsWith('.wasm') ? name : `${name}.wasm`), false, true);
                    await runWasm(handle, cmdObj.args, io);
                } catch { print(`bvfs: ${name}: command not found\n`, true); break; }
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
            } else { prevOut = currOut; }
        }
        if (prevOut && !pipeline[pipeline.length - 1].redirectOut) print(prevOut);
    };

    if (isBackground) {
        const jId = jobIdCounter++;
        jobs.push({ id: jId, cmd: input, status: 'Running' });
        print(`[${jId}] started\n`);
        execLogic().then(() => {
            jobs = jobs.filter(j => j.id !== jId);
            print(`\n[${jId}] + Done       ${input}\n`);
            ui.prompt.innerText = `${ENV.USER}@bvfs:${ENV.PWD}$ `;
        });
    } else {
        await execLogic();
    }
}

async function execute(input) {
    if (history[history.length - 1] !== input && input.trim()) {
        history.push(input);
        if (history.length > 500) history.shift();
        localStorage.setItem('bvfs_hist', JSON.stringify(history));
    }
    histCursor = history.length;
    await executeInternal(input, false);
}

window.onload = async () => {
    print("BVFS Micro-Kernel v4.0 TITAN initializing...\n");
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
