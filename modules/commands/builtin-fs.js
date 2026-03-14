import { readDir, readFile } from '../vfs.js';
import { resolvePath } from '../path.js';
import { ENV } from '../env.js';

export const commands = {
    pwd: async (args, io) => io.stdout(ENV.PWD + '\n'),
    clear: async (args, io) => io.clear(),
    echo: async (args, io) => io.stdout(args.join(' ') + '\n'),
    cd: async (args, io) => {
        const target = resolvePath(ENV.PWD, args[0] || ENV.HOME);
        try { await readDir(target); ENV.PWD = target; } 
        catch (e) { io.stderr(`cd: ${args[0]}: No such file or directory\n`); }
    },
    ls: async (args, io) => {
        const target = resolvePath(ENV.PWD, args[0] || '.');
        try {
            const entries = await readDir(target);
            io.stdout(entries.map(e => e.kind === 'directory' ? `${e.name}/` : e.name).join('  ') + '\n');
        } catch (e) { io.stderr(`ls: cannot access '${target}': No such file or directory\n`); }
    },
    cat: async (args, io) => {
        if (!args.length && io.stdin) return io.stdout(io.stdin);
        for (const file of args) {
            try {
                const content = await readFile(resolvePath(ENV.PWD, file));
                io.stdout(content + (content.endsWith('\n') ? '' : '\n'));
            } catch (e) { io.stderr(`cat: ${file}: No such file or directory\n`); }
        }
    }
};
