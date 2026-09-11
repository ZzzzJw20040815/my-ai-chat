export const WALLPAPER_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
export const MAX_WALLPAPER_BYTES = 25 * 1024 * 1024;

export function validateWallpaperFile(file) {
  if (!file || !WALLPAPER_TYPES.includes(file.type)) {
    throw new Error('Choose a JPEG, PNG, or WebP image.');
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    throw new Error('This image file is empty or unreadable.');
  }
  if (file.size > MAX_WALLPAPER_BYTES) {
    throw new Error('Wallpaper images must be 25 MB or smaller.');
  }
  return file;
}

export function decodeWallpaperImage(file, dependencies = {}) {
  const urlApi = dependencies.urlApi || URL;
  const ImageConstructor = dependencies.ImageConstructor || Image;
  return new Promise((resolve, reject) => {
    const temporaryUrl = urlApi.createObjectURL(file);
    const image = new ImageConstructor();
    const finish = callback => {
      image.onload = null;
      image.onerror = null;
      urlApi.revokeObjectURL(temporaryUrl);
      callback();
    };
    image.onload = () => finish(() => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) resolve(file);
      else reject(new Error('This image could not be decoded.'));
    });
    image.onerror = () => finish(() => reject(new Error('This image could not be decoded.')));
    image.src = temporaryUrl;
  });
}

export function createWallpaperPresenter({ conversation, preview, urlApi = URL }) {
  let objectUrl = null;
  return {
    show(record) {
      const nextUrl = urlApi.createObjectURL(record.blob);
      conversation.style.setProperty('--chat-wallpaper-image', `url("${nextUrl}")`);
      conversation.classList.add('has-wallpaper');
      preview.src = nextUrl;
      const previousUrl = objectUrl;
      objectUrl = nextUrl;
      if (previousUrl) urlApi.revokeObjectURL(previousUrl);
      return nextUrl;
    },
    clear() {
      conversation.classList.remove('has-wallpaper');
      conversation.style.removeProperty('--chat-wallpaper-image');
      preview.removeAttribute('src');
      if (objectUrl) urlApi.revokeObjectURL(objectUrl);
      objectUrl = null;
    },
    dispose() {
      this.clear();
    },
  };
}
