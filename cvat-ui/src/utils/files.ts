// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

export function getFileContentTypeByMimeType(mimeType: string): string {
    return mimeType.split('/')[0];
}

export function getFileContentType(file: File): string {
    return getFileContentTypeByMimeType(file.type);
}

export function checkFileTypesEqual(files: File[]): boolean {
    if (!files.length) return true;
    const typeFirstFile: string = getFileContentType(files[0]);
    return files.every((file) => getFileContentType(file) === typeFirstFile);
}

function getUrlExtension(url: string): string {
    return (url.split(/[#?]/)[0].split('.').pop()?.trim() || '').toLowerCase();
}

// source https://developer.mozilla.org/en-US/docs/Web/Media/Formats/Image_types
const IMAGE_EXTENSIONS = ['3ds', 'ag', 'arw', 'bay', 'bmp', 'bmq', 'cgm', 'cr2', 'crw', 'cs1', 'cs2', 'cur', 'dcr',
    'dds', 'djv', 'djvu', 'dng', 'dwg', 'dxf', 'emf', 'eps', 'eps.bz2', 'eps.gz', 'epsf', 'epsf.bz2', 'epsf.gz',
    'epsi', 'epsi.bz2', 'epsi.gz', 'erf', 'exr', 'fff', 'fig', 'fits', 'g3', 'gif', 'hdr', 'hrd', 'icb',
    'icns', 'ico', 'ief', 'iff', 'ilbm', 'jng', 'jp2', 'jpe', 'jpeg', 'jpf', 'jpg', 'jpx', 'k25', 'kdc',
    'lbm', 'lwo', 'lwob', 'lws', 'mdc', 'mdi', 'mos', 'mrw.', 'msod', 'nef', 'ora', 'orf', 'pbm', 'pct', 'pcx',
    'pef', 'pgm', 'pic', 'pict', 'pict1', 'pict2', 'png', 'pnm', 'pntg', 'pnx', 'ppm', 'psd', 'qif', 'qtif', 'raf',
    'ras', 'raw', 'rdc', 'rgb', 'rle', 'rp', 'rw2', 'sgi', 'sk', 'sk1', 'sr2', 'srf', 'sun', 'svg', 'svgz', 'tga',
    'tif', 'tiff', 'tpic', 'vda', 'vst', 'wbmp', 'webp', 'wmf', 'x3f', 'xbm', 'xcf', 'xcf.bz2', 'xcf.gz', 'xpm', 'xwd',
];

// source https://en.wikipedia.org/wiki/Video_file_format
const VIDEO_EXTENSIONS = ['3g2', '3ga', '3gp', '3gp2', '3gpp', '3gpp2', 'amv', 'asf', 'avf', 'avi', 'axv', 'bdm',
    'bdmv', 'clpi', 'cpi', 'divx', 'drc', 'dv', 'f4a', 'f4b', 'f4p', 'f4v', 'flc', 'fli', 'flv', 'fxm', 'gifv',
    'lrv', 'm1u', 'm2t', 'm2ts', 'm2v', 'm4p', 'm4u', 'm4v', 'mk3d', 'mkv', 'mng', 'moov', 'mov', 'movie',
    'mp2', 'mp4', 'mpe', 'mpeg', 'mpg', 'mpl', 'mpls', 'mpv', 'mts', 'mxf', 'mxu', 'nsv', 'ogg', 'ogm', 'ogv',
    'qt', 'qtvr', 'rm', 'rmvb', 'roq', 'rv', 'rvx', 'svi', 'ts', 'vdr', 'viv', 'vivo', 'vob', 'webm', 'wmp', 'wmv', 'yuv',
];

export function getContentTypeRemoteFile(url: string): 'image' | 'video' | 'unknown' {
    const extension = getUrlExtension(url);
    if (IMAGE_EXTENSIONS.includes(extension)) {
        return 'image';
    }

    if (VIDEO_EXTENSIONS.includes(extension)) {
        return 'video';
    }

    return 'unknown';
}

export function getFileNameFromPath(path: string): string {
    return path.split('/').filter(Boolean).pop()?.split(/[#?]/)?.[0] || '';
}

export function isImageFileName(filename: string): boolean {
    const ext = filename.split('.').pop()?.trim().toLowerCase() || '';
    return IMAGE_EXTENSIONS.includes(ext);
}

export function getWebkitRelativePath(file: File): string {
    return (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
}

export interface LocalFolderGroup {
    name: string;
    files: File[];
}

function splitRelativePath(file: File): string[] {
    return getWebkitRelativePath(file).replace(/\\/g, '/').split('/').filter(Boolean);
}

function commonPrefixLength(paths: string[][]): number {
    if (!paths.length) {
        return 0;
    }
    let index = 0;
    while (true) {
        const token = paths[0][index];
        if (token === undefined) {
            return index;
        }
        if (!paths.every((path) => path[index] === token)) {
            return index;
        }
        index += 1;
    }
}

/**
 * Group directory-picker files by each immediate child of the selected folder.
 * Browsers often prefix webkitRelativePath with the selected folder name
 * (parent/folder1/a.jpg), so grouping by the first segment would collapse
 * every subfolder into one task.
 */
export function groupLocalFilesByTopFolder(files: File[]): {
    mode: 'flat' | 'folders';
    groups: LocalFolderGroup[];
} {
    const images = files.filter((file) => isImageFileName(file.name));
    if (!images.length) {
        return { mode: 'flat', groups: [] };
    }

    const withDirs = images.map((file) => {
        const parts = splitRelativePath(file);
        return {
            file,
            dirParts: parts.length > 1 ? parts.slice(0, -1) : [],
        };
    });
    if (!withDirs.some((item) => item.dirParts.length > 0)) {
        return {
            mode: 'flat',
            groups: [{ name: '', files: images }],
        };
    }

    const prefixLen = commonPrefixLength(withDirs.map((item) => item.dirParts));
    const map = new Map<string, File[]>();
    withDirs.forEach(({ file, dirParts }) => {
        const name = dirParts[prefixLen] || 'root';
        const list = map.get(name) || [];
        list.push(file);
        map.set(name, list);
    });

    const groups = Array.from(map.entries())
        .map(([name, groupFiles]) => ({ name, files: groupFiles }))
        .filter((group) => group.files.length > 0)
        .sort((left, right) => left.name.localeCompare(right.name));

    return {
        mode: groups.length > 1 ? 'folders' : 'flat',
        groups,
    };
}

/** Directory picker files keep webkitRelativePath. Keep only images in that case. */
export function prepareLocalUploadFiles(files: File[]): {
    files: File[];
    fromDirectory: boolean;
} {
    const fromDirectory = files.some((file) => getWebkitRelativePath(file).includes('/'));
    if (!fromDirectory) {
        return { files, fromDirectory: false };
    }

    const grouped = groupLocalFilesByTopFolder(files);
    return {
        files: grouped.groups.flatMap((group) => group.files),
        fromDirectory: true,
    };
}
