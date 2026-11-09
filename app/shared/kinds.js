// File kinds by extension. Shared by the scanner (hub) and the interface.

const GROUPS = {
  video: 'mp4 m4v mov mkv avi wmv flv webm mpg mpeg m2ts mts ts 3gp vob ogv',
  image: 'jpg jpeg png gif bmp webp heic heif tif tiff raw cr2 cr3 nef arw dng orf rw2 raf svg ico psd avif',
  audio: 'mp3 wav flac aac m4a ogg opus wma aiff aif alac mid midi',
  document: 'pdf doc docx xls xlsx ppt pptx odt ods odp txt rtf md csv epub mobi pages numbers key one',
  archive: 'zip rar 7z tar gz tgz bz2 xz zst cab lz lzma',
  disk: 'iso img vhd vhdx vmdk dmg wim esd vdi qcow2',
  app: 'exe msi apk appx msix msixbundle dll sys bat cmd ps1 vbs reg sh jar com',
  code: 'js mjs ts tsx jsx py c cpp h hpp cs java go rs php html htm css scss json xml yml yaml sql kt swift rb lua'
};

const BY_EXT = new Map();
for (const [kind, list] of Object.entries(GROUPS)) for (const ext of list.split(' ')) BY_EXT.set(ext, kind);

export const KINDS = [
  { id: 'video', name: 'Videos', icon: 'video' },
  { id: 'image', name: 'Photos', icon: 'image' },
  { id: 'audio', name: 'Audio', icon: 'audio' },
  { id: 'document', name: 'Documents', icon: 'file' },
  { id: 'archive', name: 'Archives', icon: 'archive' },
  { id: 'disk', name: 'Disk images', icon: 'disc' },
  { id: 'app', name: 'Apps', icon: 'app' },
  { id: 'code', name: 'Code', icon: 'code' },
  { id: 'other', name: 'Other', icon: 'file' }
];

export const kindName = (id) => (id === 'folder' ? 'Folder' : (KINDS.find((k) => k.id === id) || KINDS.at(-1)).name);
export const kindIcon = (id) => (id === 'folder' ? 'folder' : (KINDS.find((k) => k.id === id) || KINDS.at(-1)).icon);

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : '';
}

export const kindOf = (ext) => BY_EXT.get(ext) || 'other';

// Media files whose headers we read for resolution, duration and date taken.
export const MEDIA_EXTS = new Set('jpg jpeg png gif bmp webp mp4 m4v mov 3gp mkv webm avi'.split(' '));

// Flags stored per entry.
export const FLAG = { HIDDEN: 1, SYSTEM: 2, DENIED: 4, LINK: 8, EXCLUDED: 16 };
