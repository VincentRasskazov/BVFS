export function resolvePath(cwd, target) {
    if (!target) return cwd;
    let base = target.startsWith('/') ? '/' : cwd;
    let parts = (base === '/' ? [] : base.split('/').filter(Boolean))
        .concat(target.split('/').filter(Boolean));
    
    let resolved = [];
    for (let part of parts) {
        if (part === '.') continue;
        if (part === '..') resolved.pop();
        else resolved.push(part);
    }
    return '/' + resolved.join('/');
}

export function dirname(path) {
    let parts = path.split('/').filter(Boolean);
    parts.pop();
    return '/' + parts.join('/');
}

export function basename(path) {
    let parts = path.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : '/';
}
