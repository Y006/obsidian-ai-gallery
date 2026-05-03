const { Plugin, Notice, Scope, TFolder, TFile, normalizePath, PluginSettingTab, Setting } = require('obsidian');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

class LRUCache {
    constructor(maxSize = 100) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }

    get(key) {
        if (!this.cache.has(key)) return undefined;
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }

    clear() {
        this.cache.clear();
    }
}

class MediaGalleryPlugin extends Plugin {
    constructor(app, manifest) {
        super(app, manifest);
        this.thumbnailCache = new LRUCache(200);
        this.intersectionObserver = null;
        this.pendingRequests = new Map();
        this.workerPool = [];
        this.maxWorkers = 4;
        this.settings = null;
        this.lastImportStats = {
            updatedAt: null,
            movedCount: 0,
            totalCount: 0,
            ruleCounts: {}
        };
    }

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new MediaGallerySettingTab(this.app, this));

        this.initWorkerPool();

        this.processor = this.registerMarkdownCodeBlockProcessor('memories', async (source, el, ctx) => {
            try {
                const config = this.parseConfig(source);
                await this.createGallery(el, config, ctx);
            } catch (error) {
                console.error('Media Gallery Error:', error);
                el.createEl('div', {
                    text: 'Error loading gallery',
                    cls: 'memories-gallery-error'
                });
            }
        });

        this.initIntersectionObserver();
    }

    async loadSettings() {
        const data = await this.loadData();
        const loaded = data || {};

        let importRules;
        if (loaded.importRules && Array.isArray(loaded.importRules)) {
            importRules = loaded.importRules;
        } else {
            importRules = [
                { prefix: loaded.chatgptPrefix || 'ChatGPT Image ', label: 'GPT', enabled: true },
                { prefix: loaded.geminiPrefix || 'Gemini_Generated_Image_', label: 'Gemini', enabled: true }
            ];
        }

        this.settings = {
            sourceDir: loaded.sourceDir || path.join(os.homedir(), 'Downloads'),
            targetFolder: loaded.targetFolder || 'pic',
            noteFile: loaded.noteFile || 'Gemini Banana 图片浏览器.md',
            lightboxFillWindow: loaded.lightboxFillWindow !== undefined ? loaded.lightboxFillWindow : false,
            importRules
        };
        if (loaded.lastImportStats) {
            this.lastImportStats = loaded.lastImportStats;
            if (!this.lastImportStats.ruleCounts) {
                this.lastImportStats.ruleCounts = {};
            }
        }
    }

    async saveSettings() {
        await this.saveData(Object.assign({}, this.settings, { lastImportStats: this.lastImportStats }));
    }

    parseConfig(source) {
        const lines = source.trim().split('\n');
        const config = {
            paths: [],
            sortOrder: 'date-desc',
            enableLazyLoad: true,
            gridSize: 200,
            displayType: 'full',
            limit: 50,
            batchSize: 10,
            preloadCount: 3,
            maxHeight: null
        };

        const cleanPath = (p) => {
            let np = normalizePath((p || '').trim());
            if (np === '.') np = './';
            return np;
        };
        
        for (let line of lines) {
            line = line.trim();
            // Skip HTML comments and Markdown table rows that may have been
            // accidentally written into the code block by old updateNoteTable
            if (!line || line.startsWith('<!--') || line.startsWith('|') || line === '<!--') {
                continue;
            }
            if (line.startsWith('paths:')) {
                const pathsStr = line.substring(6).trim();
                config.paths = pathsStr
                    .split(',')
                    .map(cleanPath)
                    .filter(Boolean);
            } else if (line.startsWith('sort:')) {
                config.sortOrder = line.substring(5).trim();
            } else if (line.startsWith('lazy:')) {
                config.enableLazyLoad = line.substring(5).trim() === 'true';
            } else if (line.startsWith('size:')) {
                config.gridSize = parseInt(line.substring(5).trim()) || 200;
            } else if (line.startsWith('type:')) {
                config.displayType = line.substring(5).trim();
            } else if (line.startsWith('limit:')) {
                config.limit = parseInt(line.substring(6).trim()) || 50;
            } else if (line.startsWith('batch:')) {
                config.batchSize = parseInt(line.substring(6).trim()) || 10;
            } else if (line.startsWith('maxHeight:')) {
                const val = line.substring(10).trim();
                config.maxHeight = val || null;
            } else if (line && !line.includes(':')) {
                config.paths = [cleanPath(line)];
            }
        }
        
        if (config.paths.length === 0) {
            config.paths = ['./'];
        }
        
        if (config.displayType === 'compact' && !lines.some(line => line.trim().startsWith('limit:'))) {
            config.limit = 9;
        }

        return config;
    }

    initWorkerPool() {
        for (let i = 0; i < this.maxWorkers; i++) {
            const worker = this.createThumbnailWorker();
            if (worker) {
                this.workerPool.push({
                    worker,
                    busy: false
                });
            }
        }
    }

    createThumbnailWorker() {
        if (typeof Worker === 'undefined') return null;
        
        const workerCode = `
            self.addEventListener('message', async (e) => {
                const { id, videoPath, timestamp } = e.data;
                try {
                    const response = await fetch(videoPath);
                    const blob = await response.blob();
                    const url = URL.createObjectURL(blob);
                    
                    const video = document.createElement('video');
                    video.crossOrigin = 'anonymous';
                    video.muted = true;
                    video.src = url;
                    video.currentTime = timestamp;
                    
                    await new Promise((resolve, reject) => {
                        video.onloadeddata = resolve;
                        video.onerror = reject;
                        setTimeout(resolve, 1000);
                    });
                    
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    canvas.width = video.videoWidth;
                    canvas.height = video.videoHeight;
                    ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
                    
                    const thumbnail = canvas.toDataURL('image/jpeg', 0.8);
                    URL.revokeObjectURL(url);
                    
                    self.postMessage({ id, thumbnail });
                } catch (error) {
                    self.postMessage({ id, error: error.message });
                }
            });
        `;
        
        try {
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            return new Worker(URL.createObjectURL(blob));
        } catch (error) {
            console.warn('Web Workers not supported, falling back to main thread');
            return null;
        }
    }

    async getVideoThumbnailWorker(file, resourcePath) {
        if (this.thumbnailCache.has(file.path)) {
            return this.thumbnailCache.get(file.path);
        }
        
        const availableWorker = this.workerPool.find(w => !w.busy);
        if (!availableWorker) {
            return this.getVideoThumbnailFallback(file, resourcePath);
        }
        
        return new Promise((resolve) => {
            const id = `${file.path}-${Date.now()}`;
            availableWorker.busy = true;
            
            const messageHandler = (e) => {
                if (e.data.id === id) {
                    availableWorker.worker.removeEventListener('message', messageHandler);
                    availableWorker.busy = false;
                    
                    if (e.data.thumbnail) {
                        this.thumbnailCache.set(file.path, e.data.thumbnail);
                        resolve(e.data.thumbnail);
                    } else {
                        resolve(this.getVideoThumbnailFallback(file, resourcePath));
                    }
                }
            };
            
            availableWorker.worker.addEventListener('message', messageHandler);
            availableWorker.worker.postMessage({
                id,
                videoPath: resourcePath,
                timestamp: 1
            });
            
            setTimeout(() => {
                availableWorker.worker.removeEventListener('message', messageHandler);
                availableWorker.busy = false;
                resolve(this.getVideoThumbnailFallback(file, resourcePath));
            }, 5000);
        });
    }

    async getVideoThumbnailFallback(file, resourcePath) {
        if (this.thumbnailCache.has(file.path)) {
            return this.thumbnailCache.get(file.path);
        }
        
        return new Promise((resolve) => {
            const video = document.createElement('video');
            const canvas = document.createElement('canvas');
            
            video.crossOrigin = 'anonymous';
            video.muted = true;
            video.src = resourcePath;
            video.currentTime = 1;
            
            let loaded = false;
            
            const cleanup = () => {
                if (!loaded) {
                    video.remove();
                    canvas.remove();
                    resolve(null);
                }
            };
            
            setTimeout(cleanup, 3000);
            
            video.onloadeddata = () => {
                loaded = true;
                try {
                    const ctx = canvas.getContext('2d');
                    canvas.width = video.videoWidth;
                    canvas.height = video.videoHeight;
                    ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
                    
                    const thumbnail = canvas.toDataURL('image/jpeg', 0.8);
                    this.thumbnailCache.set(file.path, thumbnail);
                    
                    resolve(thumbnail);
                } catch (error) {
                    resolve(null);
                } finally {
                    video.remove();
                    canvas.remove();
                }
            };
            
            video.onerror = cleanup;
        });
    }

    async createGallery(el, config, ctx) {
        el.empty();
        el.ctx = ctx;
        el.sourcePath = ctx.sourcePath;

        this.thumbnailCache.clear();
        this.pendingRequests.clear();

        const loadingIndicator = el.createEl('div', { cls: 'memories-gallery-loading' });
        // Show skeleton placeholders while loading
        const skeletonCount = Math.min(config.limit || 8, 8);
        for (let i = 0; i < skeletonCount; i++) {
            loadingIndicator.createEl('div', { cls: 'memories-gallery-skeleton' });
        }
        
        try {
            const controller = new AbortController();
            ctx.containerEl.onNodeRemoved = () => controller.abort();
            
            const allMediaFiles = await this.loadMediaFiles(config.paths, controller.signal);
            
            if (allMediaFiles.length === 0) {
                loadingIndicator.remove();
                el.createEl('div', {
                    text: 'No media files found',
                    cls: 'memories-gallery-empty'
                });
                return;
            }
            
            const sortedFiles = this.sortFiles(allMediaFiles, config.sortOrder);
            loadingIndicator.remove();
            
            await this.renderGallery(el, sortedFiles, config, controller.signal);
            
        } catch (error) {
            if (error.name !== 'AbortError') {
                loadingIndicator.remove();
                el.createEl('div', {
                    text: `Error: ${error.message}`,
                    cls: 'memories-gallery-error'
                });
            }
        }
    }

    async loadMediaFiles(paths, signal) {
        const allMediaFiles = [];
        
        if (paths.length === 1 && paths[0] === './') {
            const rootFolder = this.app.vault.getRoot();
            allMediaFiles.push(...this.getAllMediaFromRoot(rootFolder));
        } else {
            for (const folderPath of paths) {
                if (signal.aborted) break;
                
                const folder = this.app.vault.getAbstractFileByPath(folderPath);
                if (!folder) continue;
                
                if (folder instanceof TFolder) {
                    const mediaFiles = this.getMediaFiles(folder);
                    allMediaFiles.push(...mediaFiles);
                }
            }
        }
        
        return allMediaFiles;
    }

    async renderGallery(el, files, config, signal) {
        const galleryContainer = el.createEl('div', { cls: 'memories-media-gallery-container' });
        galleryContainer.ctx = el.ctx;
        galleryContainer.sourcePath = el.sourcePath;
        galleryContainer._config = config;

        if (config.maxHeight) {
            galleryContainer.classList.add('memories-gallery-fixed-frame');
            galleryContainer.style.maxHeight = config.maxHeight;
        }

        const infoBar = galleryContainer.createEl('div', { cls: 'memories-gallery-info-bar' });

        // Title row — full width
        const titleRow = infoBar.createEl('div', { cls: 'memories-gallery-title-row' });
        titleRow.createEl('div', {
            cls: 'memories-gallery-title',
            text: 'AI Gallery'
        });

        // Stats + buttons row — side by side
        const bottomRow = infoBar.createEl('div', { cls: 'memories-gallery-bottom-row' });
        const statsWrap = bottomRow.createEl('div', { cls: 'memories-gallery-stats-wrap' });
        const rightActions = bottomRow.createEl('div', { cls: 'memories-gallery-info-right' });

        const totalBytes = files.reduce((sum, file) => sum + file.stat.size, 0);
        const totalSize = this.formatFileSize(totalBytes);

        const importRules = this.settings?.importRules || [];
        const enabledRules = importRules.filter(r => r.enabled !== false);

        const ruleCounts = {};
        let totalImages = 0;

        for (const rule of enabledRules) {
            const count = files.filter(f => f.name.startsWith(rule.prefix) && f.name.endsWith('.png')).length;
            ruleCounts[rule.prefix] = count;
            totalImages += count;
        }

        const displayCount = config.displayType === 'compact'
            ? Math.min(files.length, config.limit)
            : files.length;

        const updatedAt = this.lastImportStats.updatedAt
            ? this.formatCompactDateTime(this.lastImportStats.updatedAt)
            : '未导入';

        const stats = [
            ['更新', updatedAt],
            ['本次', this.lastImportStats.movedCount || 0],
            ['图片', totalImages],
            ['显示', displayCount]
        ];

        for (const rule of enabledRules) {
            const count = ruleCounts[rule.prefix] || 0;
            const label = rule.label || rule.prefix || '规则';
            stats.push([label, count]);
        }

        stats.push(['占用', totalSize]);

        const table = statsWrap.createEl('table', { cls: 'memories-gallery-meta-table' });

        const thead = table.createEl('thead');
        const headRow = thead.createEl('tr');

        for (const [label] of stats) {
            headRow.createEl('th', { text: label });
        }

        const tbody = table.createEl('tbody');
        const valueRow = tbody.createEl('tr');

        for (const [, value] of stats) {
            valueRow.createEl('td', { text: String(value) });
        }

        this.createImportButton(rightActions, config, files, galleryContainer);

        const galleryBody = galleryContainer.createEl('div', { cls: 'memories-gallery-body' });
        const grid = galleryBody.createEl('div', { cls: 'memories-media-gallery-grid' });
        grid.style.setProperty('--memories-grid-size', `${config.gridSize}px`);

        const filesToDisplay = config.displayType === 'compact' ?
            files.slice(0, config.limit) :
            files;

        grid.dataset.allFiles = JSON.stringify(files.map(f => ({ name: f.name, path: f.path })));

        await this.renderBatchItems(grid, filesToDisplay, config, signal, 0);
    }

    async renderBatchItems(container, files, config, signal, startIndex = 0) {
        const batchSize = config.batchSize || 10;
        const endIndex = Math.min(startIndex + batchSize, files.length);
        
        for (let i = startIndex; i < endIndex; i++) {
            if (signal.aborted) return;
            
            const file = files[i];
            const item = container.createEl('div', { cls: 'memories-gallery-item' });
            
            if (config.enableLazyLoad) {
                item.dataset.file = JSON.stringify({
                    name: file.name,
                    path: file.path,
                    index: i
                });
                item.classList.add('lazy-load');
                
                const placeholder = item.createEl('div', { cls: 'memories-gallery-placeholder' });
                placeholder.createEl('span', { text: this.getFileTypeIcon(file.name) });
                
                this.intersectionObserver.observe(item);
            } else {
                const grid = container.closest('.memories-media-gallery-grid');
                let allMediaFiles = [file];
                if (grid && grid.dataset.allFiles) {
                    allMediaFiles = JSON.parse(grid.dataset.allFiles).map(fileInfo => 
                        this.app.vault.getAbstractFileByPath(fileInfo.path)
                    ).filter(Boolean);
                }
                await this.loadMediaElement(item, file, i, allMediaFiles);
            }
        }
        
        if (endIndex < files.length && !signal.aborted) {
            await new Promise(resolve => setTimeout(resolve, 0));
            await this.renderBatchItems(container, files, config, signal, endIndex);
        }
    }

    initIntersectionObserver() {
        this.intersectionObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const item = entry.target;
                    this.loadMediaElement(item).catch(console.error);
                    this.intersectionObserver.unobserve(item);
                }
            });
        }, {
            rootMargin: '100px 0px',
            threshold: 0.1
        });
    }

    async loadMediaElement(element, file = null, index = null, allMediaFiles = null) {
        if (!file && element.dataset.file) {
            const fileData = JSON.parse(element.dataset.file);
            file = this.app.vault.getAbstractFileByPath(fileData.path);
            index = fileData.index;
            
            const grid = element.closest('.memories-media-gallery-grid');
            if (grid && grid.dataset.allFiles) {
                allMediaFiles = JSON.parse(grid.dataset.allFiles).map(fileInfo => 
                    this.app.vault.getAbstractFileByPath(fileInfo.path)
                ).filter(Boolean);
            } else if (fileData.allFiles) {
                allMediaFiles = fileData.allFiles.map(fileInfo => 
                    this.app.vault.getAbstractFileByPath(fileInfo.path)
                ).filter(Boolean);
            }
        }
        
        if (!file) return;
        
        const requestKey = file.path;
        if (this.pendingRequests.has(requestKey)) {
            return;
        }
        
        this.pendingRequests.set(requestKey, true);
        
        try {
            element.empty();
            element.classList.remove('lazy-load');
            
            const resourcePath = this.app.vault.getResourcePath(file);
            
            if (this.isImage(file.name)) {
                await this.loadImageElement(element, file, resourcePath, allMediaFiles, index);
            } else if (this.isVideo(file.name)) {
                await this.loadVideoElement(element, file, resourcePath, allMediaFiles, index);
            } else if (this.isAudio(file.name)) {
                this.loadAudioElement(element, file, allMediaFiles, index);
            }
        } catch (error) {
            console.error('Error loading media element:', error);
            this.showErrorState(element, file.name);
        } finally {
            this.pendingRequests.delete(requestKey);
        }
    }

    async loadImageElement(element, file, resourcePath, allMediaFiles, index) {
        const img = element.createEl('img', {
            attr: {
                src: resourcePath,
                alt: file.name,
                loading: 'lazy'
            }
        });

        // Filename overlay on hover
        const overlay = element.createEl('div', { cls: 'memories-card-filename' });
        overlay.setText(file.name);

        requestIdleCallback(() => {
            this.registerDomEvent(img, 'click', () => {
                const galleryContainer = element.closest('.memories-media-gallery-container');
                openMediaLightbox(this.app, allMediaFiles || [file], index || 0, () => {
                    this.refreshCurrentGallery(galleryContainer);
                }, galleryContainer, this.settings.lightboxFillWindow);
            });
        });
    }

    async loadVideoElement(element, file, resourcePath, allMediaFiles, index) {
        const container = element.createEl('div', { cls: 'memories-video-thumbnail-container' });
        
        try {
            const thumbnail = await this.getVideoThumbnailWorker(file, resourcePath);
            
            if (thumbnail) {
                container.createEl('img', {
                    attr: {
                        src: thumbnail,
                        alt: file.name,
                        loading: 'lazy'
                    }
                });
            } else {
                container.createEl('video', {
                    attr: {
                        src: resourcePath,
                        muted: true,
                        preload: 'metadata'
                    }
                });
            }
        } catch (error) {
            container.createEl('video', {
                attr: {
                    src: resourcePath,
                    muted: true,
                    preload: 'metadata'
                }
            });
        }
        
        const playIcon = container.createEl('div', { cls: 'memories-video-play-icon' });
        playIcon.setText('▶');

        // Filename overlay on hover
        const overlay = element.createEl('div', { cls: 'memories-card-filename' });
        overlay.setText(file.name);

        requestIdleCallback(() => {
            this.registerDomEvent(element, 'click', () => {
                const galleryContainer = element.closest('.memories-media-gallery-container');
                openMediaLightbox(this.app, allMediaFiles || [file], index || 0, () => {
                    this.refreshCurrentGallery(galleryContainer);
                }, galleryContainer, this.settings.lightboxFillWindow);
            });
        });
    }

    loadAudioElement(element, file, allMediaFiles, index) {
        const container = element.createEl('div', { cls: 'memories-audio-thumbnail-container' });
        const icon = container.createEl('div', { cls: 'memories-audio-icon' });
        icon.setText('🎵');

        const fileName = container.createEl('div', { cls: 'memories-audio-filename' });
        fileName.textContent = file.name;

        // Filename overlay on hover
        const overlay = element.createEl('div', { cls: 'memories-card-filename' });
        overlay.setText(file.name);

        requestIdleCallback(() => {
            this.registerDomEvent(container, 'click', () => {
                const galleryContainer = element.closest('.memories-media-gallery-container');
                openMediaLightbox(this.app, allMediaFiles || [file], index || 0, () => {
                    this.refreshCurrentGallery(galleryContainer);
                }, galleryContainer, this.settings.lightboxFillWindow);
            });
        });
    }

    async refreshCurrentGallery(galleryContainer) {
        if (!galleryContainer) return;

        try {
            const parentEl = galleryContainer.parentElement;
            const config = galleryContainer._config;
            const ctx = galleryContainer.ctx;
            const sourcePath = galleryContainer.sourcePath;

            if (parentEl && config && ctx) {
                galleryContainer.classList.add('memories-gallery-refreshing');

                const scrollPos = window.scrollY;

                parentEl.empty();
                parentEl.ctx = ctx;
                parentEl.sourcePath = sourcePath;
                await this.createGallery(parentEl, config, ctx);

                window.scrollTo(0, scrollPos);

                galleryContainer.classList.remove('memories-gallery-refreshing');
            }
        } catch (error) {
            console.error('Error refreshing gallery:', error);
            if (galleryContainer) {
                galleryContainer.classList.remove('memories-gallery-refreshing');
            }
        }
    }

    showErrorState(element, filename) {
        element.empty();
        const errorDiv = element.createEl('div', { cls: 'memories-gallery-error-state' });
        errorDiv.createEl('div', { text: '❌' });
        errorDiv.createEl('div', { 
            text: filename,
            cls: 'memories-gallery-error-filename'
        });
    }

    getAllMediaFromRoot(folder) {
        const mediaFiles = [];

        const traverse = (currentFolder) => {
            if (!(currentFolder instanceof TFolder)) return;
            
            for (const child of currentFolder.children) {
                if (child instanceof TFolder) {
                    traverse(child);
                } else if (child instanceof TFile) {
                    if (this.isMediaFile(child.name)) {
                        mediaFiles.push(child);
                    }
                }
            }
        };
        
        traverse(folder);
        return mediaFiles;
    }

    getMediaFiles(folder) {
        const mediaFiles = [];

        if (!(folder instanceof TFolder)) {
            return mediaFiles;
        }
        
        for (const child of folder.children) {
            if (child instanceof TFile && this.isMediaFile(child.name)) {
                mediaFiles.push(child);
            }
        }
        
        return mediaFiles;
    }

    isMediaFile(filename) {
        return this.isImage(filename) || this.isVideo(filename) || this.isAudio(filename);
    }

    isImage(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        return ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'tiff', 'tif', 'avif', 'heic', 'heif', 'ico'].includes(ext);
    }

    isVideo(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        return ['mp4', 'webm', 'ogv', 'mov', 'avi', 'mkv', 'flv', 'wmv', '3gp', 'm4v', 'mpg', 'mpeg', 'm2v', 'asf'].includes(ext);
    }

    isAudio(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        return ['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'wma', 'opus', 'aiff', 'au'].includes(ext);
    }

    getFileTypeIcon(filename) {
        if (this.isImage(filename)) return '🖼️';
        if (this.isVideo(filename)) return '🎬';
        if (this.isAudio(filename)) return '🎵';
        return '📄';
    }

    sortFiles(files, sortOrder) {
        switch (sortOrder) {
            case 'date-asc':
                return files.sort((a, b) => a.stat.mtime - b.stat.mtime);
            case 'date-desc':
                return files.sort((a, b) => b.stat.mtime - a.stat.mtime);
            case 'random':
                return this.shuffleArray([...files]);
            case 'name-asc':
            default:
                return files.sort((a, b) => a.name.localeCompare(b.name));
        }
    }

    shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    createImportButton(container, config, files, galleryContainer) {
        const importBtn = container.createEl('button', {
            text: '导入图片',
            cls: 'memories-gallery-upload-btn'
        });

        this.registerDomEvent(importBtn, 'click', () => {
            this.importImages(config, files, galleryContainer, importBtn);
        });

        const settingsBtn = container.createEl('button', {
            text: '设置',
            cls: 'memories-gallery-settings-btn'
        });

        this.registerDomEvent(settingsBtn, 'click', () => {
            this.openSettings();
        });
    }

    showUploadForm(config, files, galleryContainer) {
        const overlay = document.createElement('div');
        overlay.className = 'memories-upload-form-overlay';
        
        const form = document.createElement('div');
        form.className = 'memories-upload-form';
        
        const title = form.createEl('h3');
        title.textContent = 'Upload media files';
        
        const pathSection = form.createEl('div');
        pathSection.className = 'memories-upload-path-section';
        pathSection.createEl('label', { text: 'Destination folder:' });
        
        const pathSelect = pathSection.createEl('select');
        pathSelect.className = 'memories-upload-path-select';
        
        config.paths.forEach(path => {
            const option = pathSelect.createEl('option');
            option.value = path;
            option.textContent = path;
        });
        
        const dropArea = form.createEl('div');
        dropArea.className = 'memories-upload-drop-area';
        
        const dropContent = dropArea.createEl('div', { cls: 'memories-drop-area-content' });
        dropContent.createEl('div', { cls: 'memories-drop-icon', text: '📁' });
        dropContent.createEl('p', { text: 'Drag and drop files here or click to browse' });
        dropContent.createEl('p', { cls: 'memories-drop-hint', text: 'Supports: images, videos, audio' });
        dropContent.createEl('p', { cls: 'memories-drop-hint', text: 'Or press Ctrl+V to paste from clipboard' });
        
        const buttonSection = form.createEl('div');
        buttonSection.className = 'memories-upload-button-section';
        
        const cancelBtn = buttonSection.createEl('button', {
            text: 'Cancel',
            cls: 'memories-upload-cancel-btn'
        });
        
        const uploadBtn = buttonSection.createEl('button', {
            text: 'Upload files',
            cls: 'memories-upload-confirm-btn'
        });
        uploadBtn.disabled = true;
        
        form.appendChild(pathSection);
        form.appendChild(dropArea);
        form.appendChild(buttonSection);
        overlay.appendChild(form);
        document.body.appendChild(overlay);
        
        this.setupUploadHandlers(form, dropArea, pathSelect, uploadBtn, cancelBtn, overlay, config, galleryContainer);
    }

    setupUploadHandlers(form, dropArea, pathSelect, uploadBtn, cancelBtn, overlay, config, galleryContainer) {
        let selectedFiles = [];
        
        this.registerDomEvent(dropArea, 'click', () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.multiple = true;
            fileInput.accept = 'image/*,video/*,audio/*';
            fileInput.addEventListener('change', (e) => {
                const newFiles = Array.from(e.target.files);
                selectedFiles = [...selectedFiles, ...newFiles];
                this.updateDropArea(dropArea, selectedFiles);
                this.updateFileList(form, selectedFiles);
                uploadBtn.disabled = selectedFiles.length === 0;
            });
            fileInput.click();
        });
        
        this.registerDomEvent(dropArea, 'dragover', (e) => {
            e.preventDefault();
            dropArea.classList.add('dragover');
        });
        
        this.registerDomEvent(dropArea, 'dragleave', () => {
            dropArea.classList.remove('dragover');
        });
        
        this.registerDomEvent(dropArea, 'drop', (e) => {
            e.preventDefault();
            dropArea.classList.remove('dragover');
            const newFiles = Array.from(e.dataTransfer.files);
            selectedFiles = [...selectedFiles, ...newFiles];
            this.updateDropArea(dropArea, selectedFiles);
            this.updateFileList(form, selectedFiles);
            uploadBtn.disabled = selectedFiles.length === 0;
        });
        
        const pasteHandler = (e) => {
            // Only handle paste if form overlay still exists in DOM
            if (!document.body.contains(overlay)) return;
            
            if (e.clipboardData && e.clipboardData.files.length > 0) {
                const newFiles = Array.from(e.clipboardData.files);
                selectedFiles = [...selectedFiles, ...newFiles];
                this.updateDropArea(dropArea, selectedFiles);
                this.updateFileList(form, selectedFiles);
                uploadBtn.disabled = selectedFiles.length === 0;
                e.preventDefault();
            }
        };
        
        // Register paste event using Plugin API - will auto-cleanup on plugin unload
        this.registerDomEvent(document, 'paste', pasteHandler);
        
        this.registerDomEvent(cancelBtn, 'click', () => {
            overlay.remove();
        });
        
        this.registerDomEvent(uploadBtn, 'click', async () => {
            if (selectedFiles.length > 0) {
                await this.handleFileUpload(selectedFiles, pathSelect.value, config, galleryContainer);
                overlay.remove();
            }
        });
        
        this.registerDomEvent(overlay, 'click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
            }
        });

        this.updateFileList(form, selectedFiles);
    }

    updateDropArea(dropArea, files) {
        dropArea.empty();
        
        const content = dropArea.createEl('div');
        content.className = 'memories-drop-area-content';
        
        if (files.length > 0) {
            content.createEl('div', { cls: 'memories-drop-icon', text: '✅' });
            content.createEl('p', { text: `${files.length} file(s) selected` });
            content.createEl('p', { 
                cls: 'memories-drop-hint',
                text: 'Click to select more files or drag and drop additional files'
            });
        } else {
            content.createEl('div', { cls: 'memories-drop-icon', text: '📁' });
            content.createEl('p', { text: 'Drag and drop files here or click to browse' });
            content.createEl('p', { 
                cls: 'memories-drop-hint',
                text: 'Supports: Images, Videos, Audio'
            });
            content.createEl('p', { 
                cls: 'memories-drop-hint',
                text: 'Or press Ctrl+V to paste from clipboard'
            });
        }
        
        if (files.length > 0) {
            dropArea.classList.add('has-files');
            
            const fileListContainer = dropArea.parentElement.querySelector('.memories-upload-file-list-container');
            if (!fileListContainer) {
                const newFileListContainer = document.createElement('div');
                newFileListContainer.className = 'memories-upload-file-list-container';
                dropArea.parentElement.insertBefore(newFileListContainer, dropArea.nextSibling);
            }
            
            this.updateFileList(dropArea.parentElement, files);
        } else {
            dropArea.classList.remove('has-files');
            const fileListContainer = dropArea.parentElement.querySelector('.memories-upload-file-list-container');
            if (fileListContainer) {
                fileListContainer.remove();
            }
        }
    }

    updateFileList(container, files) {
        let fileListContainer = container.querySelector('.memories-upload-file-list-container');
        if (!fileListContainer) {
            fileListContainer = document.createElement('div');
            fileListContainer.className = 'memories-upload-file-list-container';
            const dropArea = container.querySelector('.memories-upload-drop-area');
            container.insertBefore(fileListContainer, dropArea.nextSibling);
        }
        
        fileListContainer.empty();
        
        const title = fileListContainer.createEl('div');
        title.className = 'memories-upload-file-list-title';
        title.textContent = 'Selected files:';
        
        const fileList = fileListContainer.createEl('div');
        fileList.className = 'memories-upload-file-list';
        
        files.forEach((file, index) => {
            const fileItem = fileList.createEl('div');
            fileItem.className = 'memories-upload-file-item';
            
            const fileIcon = fileItem.createEl('span');
            fileIcon.className = 'memories-upload-file-icon';
            fileIcon.textContent = this.getFileTypeIcon(file.name);
            
            const fileName = fileItem.createEl('span');
            fileName.textContent = file.name;
            fileName.className = 'memories-upload-file-name';
            
            const fileSize = fileItem.createEl('span');
            fileSize.className = 'memories-upload-file-size';
            fileSize.textContent = this.formatFileSize(file.size);
            
            const removeBtn = fileItem.createEl('button');
            removeBtn.textContent = '✕';
            removeBtn.className = 'memories-upload-remove-file';
            this.registerDomEvent(removeBtn, 'click', (e) => {
                e.stopPropagation();
                files.splice(index, 1);
                this.updateDropArea(container.querySelector('.memories-upload-drop-area'), files);
            });
        });
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));

        let size = parseFloat((bytes / Math.pow(k, i)).toFixed(2));
        let unit = sizes[i];

        if (unit === 'GB' || unit === 'TB') {
            size = Math.round(size * 10) / 10;
        }

        return `${size} ${unit}`;
    }

    formatDateTime(isoString) {
        if (!isoString) return '尚未导入';
        const d = new Date(isoString);
        if (isNaN(d.getTime())) return '尚未导入';
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    formatCompactDateTime(isoString) {
        if (!isoString) return '未导入';

        const d = new Date(isoString);
        if (isNaN(d.getTime())) return '未导入';

        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');

        const sameDay =
            d.getFullYear() === now.getFullYear() &&
            d.getMonth() === now.getMonth() &&
            d.getDate() === now.getDate();

        if (sameDay) {
            return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }

        return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    async handleFileUpload(files, targetPath, config, galleryContainer) {
        const loadingIndicator = galleryContainer.createEl('div', {
            cls: 'memories-upload-loading',
            text: `Uploading ${files.length} file(s)...`
        });
        
        try {
            for (const file of files) {
                await this.saveFileToVault(file, targetPath);
            }
            
            loadingIndicator.remove();
            await this.refreshGallery(galleryContainer, config);
            
        } catch (error) {
            loadingIndicator.remove();
            console.error('Upload error:', error);
            new Notice('Error uploading files: ' + error.message);
        }
    }

    async saveFileToVault(file, targetPath) {
        const arrayBuffer = await file.arrayBuffer();
        const fileName = this.getUniqueFileName(targetPath, file.name);
        const fullPath = `${targetPath}/${fileName}`;
        
        await this.app.vault.createBinary(fullPath, arrayBuffer);
    }

    getUniqueFileName(folderPath, fileName) {
        const fileExtension = fileName.split('.').pop();
        const baseName = fileName.substring(0, fileName.length - fileExtension.length - 1);
        
        let newName = fileName;
        let counter = 1;
        
        while (this.app.vault.getAbstractFileByPath(`${folderPath}/${newName}`)) {
            newName = `${baseName}_${counter}.${fileExtension}`;
            counter++;
        }
        
        return newName;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async refreshGallery(container, config) {
        const parentEl = container.parentElement;
        const ctx = parentEl.ctx;
        const sourcePath = parentEl.sourcePath;

        parentEl.empty();
        parentEl.ctx = ctx;
        parentEl.sourcePath = sourcePath;

        // Give vault a moment to register newly written files
        await this.sleep(150);
        await this.createGallery(parentEl, config, ctx);
    }

    async importImages(config, files, galleryContainer, importBtn) {
        importBtn.disabled = true;
        importBtn.textContent = '导入中...';

        try {
            const { sourceDir, importRules } = this.settings;

            const galleryTargetFolder = config.paths?.find(p => p && p !== './');
            const targetFolder = normalizePath(galleryTargetFolder || this.settings.targetFolder || 'pic');

            const vaultAdapter = this.app.vault.adapter;
            const vaultBasePath = vaultAdapter.getBasePath ? vaultAdapter.getBasePath() : (this.app.vault.adapter.basePath || '');
            const targetDirAbs = path.join(vaultBasePath, targetFolder);

            const matchedFiles = await this.scanSourceDir(sourceDir, importRules);

            let movedCount = 0;
            const moved = [];
            const failed = [];

            if (matchedFiles.length === 0) {
                console.log('[AI Gallery] 未检测到新的目标图片');
            }

            for (const srcPath of matchedFiles) {
                try {
                    const originalName = path.basename(srcPath);

                    const conflictExists = this.app.vault.getAbstractFileByPath(
                        normalizePath(targetFolder + '/' + originalName)
                    );

                    let finalName;
                    if (conflictExists) {
                        finalName = this.getUniqueFileName(targetFolder, originalName);
                        console.log(`[AI Gallery] 同名去重: ${originalName} → ${finalName}`);
                    } else {
                        finalName = originalName;
                    }

                    const vaultPath = normalizePath(targetFolder + '/' + finalName);
                    const destPath = path.join(targetDirAbs, finalName);

                    await fs.mkdir(path.dirname(destPath), { recursive: true });

                    const buffer = await fs.readFile(srcPath);
                    await this.app.vault.createBinary(vaultPath, buffer);

                    await fs.unlink(srcPath);

                    movedCount++;
                    moved.push(finalName);
                    console.log(`[AI Gallery] 已导入: ${finalName}`);
                } catch (err) {
                    failed.push({ file: path.basename(srcPath), error: err.message });
                    console.error(`[AI Gallery] 导入失败: ${path.basename(srcPath)}`, err);
                }
            }

            if (moved.length > 0) {
                console.log(`[AI Gallery] 已移动 ${moved.length} 张图片`);
            }
            if (failed.length > 0) {
                console.log(`[AI Gallery] 失败 ${failed.length} 张`);
            }

            const stats = await this.countImagesInTarget(targetDirAbs, importRules);
            const updatedAt = new Date().toISOString();

            this.lastImportStats = {
                updatedAt,
                movedCount,
                totalCount: stats.totalCount,
                ruleCounts: stats.ruleCounts || {}
            };

            await this.saveSettings();

            if (movedCount === 0) {
                new Notice('未检测到新的目标图片');
            } else {
                new Notice(`已经更新 ${movedCount} 张图片 → ${targetFolder}`);
                await this.refreshGallery(galleryContainer, config);
            }

        } catch (error) {
            console.error('[AI Gallery] 图片导入失败:', error);
            new Notice('图片导入失败');
        } finally {
            importBtn.disabled = false;
            importBtn.textContent = '导入图片';
        }
    }

    async scanSourceDir(sourceDir, importRules) {
        const results = [];
        const enabledRules = importRules.filter(r => r.enabled !== false);

        async function walk(dir) {
            let entries;
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(fullPath);
                } else if (entry.isFile()) {
                    const name = entry.name;
                    if (!name.endsWith('.png')) continue;
                    if (enabledRules.some(r => name.startsWith(r.prefix))) {
                        results.push(fullPath);
                    }
                }
            }
        }

        await walk(sourceDir);
        return results;
    }

    async countImagesInTarget(targetDirAbs, importRules) {
        const enabledRules = importRules.filter(r => r.enabled !== false);
        const ruleCounts = {};
        enabledRules.forEach(r => { ruleCounts[r.prefix] = 0; });

        let totalCount = 0;

        async function walk(dir) {
            let entries;
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(fullPath);
                } else if (entry.isFile() && entry.name.endsWith('.png')) {
                    for (const rule of enabledRules) {
                        if (entry.name.startsWith(rule.prefix)) {
                            ruleCounts[rule.prefix] = (ruleCounts[rule.prefix] || 0) + 1;
                            totalCount++;
                            break;
                        }
                    }
                }
            }
        }

        await walk(targetDirAbs);
        return { totalCount, ruleCounts };
    }

    async loadTargetDirFiles(targetFolder) {
        const folder = this.app.vault.getAbstractFileByPath(targetFolder);
        if (!(folder instanceof TFolder)) return [];
        const files = [];
        for (const child of folder.children) {
            if (child instanceof TFile && this.isMediaFile(child.name)) {
                files.push(child);
            }
        }
        return files;
    }

    async updateNoteTable(totalBytes, sourcePath) {
        const { noteFile, summaryLineNo } = this.settings;
        const targetNotePath = sourcePath || noteFile;

        const totalBytesForDisplay = this.formatFileSize(totalBytes);
        const updatedAt = this.lastImportStats.updatedAt
            ? this.formatDateTime(this.lastImportStats.updatedAt)
            : '尚未导入';
        const movedCount = this.lastImportStats.movedCount;

        const gptTotal = this.lastImportStats.gptTotal;
        const geminiTotal = this.lastImportStats.geminiTotal;
        const totalImages = this.lastImportStats.totalCount;
        const displayCount = totalImages;

        const tableContent = [
            '<!-- image-update-table-start -->',
            '| 更新时间 | 更新数量 | 图片总数 | 显示总数 | GPT 图片总数 | Gemini 图片总数 | 硬盘占用 |',
            '|---|---:|---:|---:|---:|---:|---:|',
            `| ${updatedAt} | ${movedCount} | ${totalImages} | ${displayCount} | ${gptTotal} | ${geminiTotal} | ${totalBytesForDisplay} |`,
            '<!-- image-update-table-end -->'
        ].join('\n');

        const tableRegex = /<!-- image-update-table-start -->[\s\S]*<!-- image-update-table-end -->/;
        const placeholderRegex = /<!-- ai-gallery-stats -->/;

        try {
            const noteAbsPath = normalizePath(targetNotePath);
            const noteFileObj = this.app.vault.getAbstractFileByPath(noteAbsPath);

            if (!noteFileObj) {
                console.warn(`[AI Gallery] 统计表更新失败：找不到笔记 ${targetNotePath}`);
                new Notice(`统计表更新失败：找不到当前笔记`);
                return;
            }

            const content = await this.app.vault.read(noteFileObj);

            let newContent;
            if (tableRegex.test(content)) {
                // Priority 1: replace existing table block
                newContent = content.replace(tableRegex, tableContent);
            } else if (placeholderRegex.test(content)) {
                // Priority 2: replace <!-- ai-gallery-stats --> placeholder
                newContent = content.replace(placeholderRegex, tableContent);
            } else {
                // Priority 3: replace line at summaryLineNo (1-based)
                const lines = content.split('\n');
                const index = Math.max(0, summaryLineNo - 1);
                while (lines.length <= index) {
                    lines.push('');
                }
                lines.splice(index, 1, tableContent);
                newContent = lines.join('\n');
            }

            await this.app.vault.modify(noteFileObj, newContent);
            console.log(`[AI Gallery] 已更新统计表: ${noteAbsPath}`);
        } catch (err) {
            console.error('[AI Gallery] 更新统计表失败:', err);
            new Notice(`统计表更新失败：${err.message}`);
        }
    }

    openSettings() {
        try {
            if (this.app.setting?.open) {
                this.app.setting.open();
                this.app.setting.openTabById(this.manifest.id);
            } else {
                new Notice('无法打开插件设置，请到设置中手动打开 AI Gallery');
            }
        } catch (err) {
            console.error('[AI Gallery] 打开设置失败:', err);
            new Notice('打开设置失败，请到设置中手动打开 AI Gallery');
        }
    }

    onunload() {
        const lightbox = document.getElementById('memories-lightbox-overlay');
        if (lightbox) lightbox.remove();
        
        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
        }
        
        this.workerPool.forEach(workerInfo => {
            workerInfo.worker.terminate();
        });
        this.workerPool = [];
        
        this.thumbnailCache.clear();
        this.pendingRequests.clear();
    }
}

function deleteCurrentFile(state) {
    const currentFile = state.mediaFiles[state.currentIndex];
    if (!currentFile) return;
    
    if (confirm(`Are you sure you want to delete "${currentFile.name}"?`)) {
        try {
            state.app.fileManager.trashFile(currentFile);
            
            state.mediaFiles.splice(state.currentIndex, 1);
            
            if (state.mediaFiles.length === 0) {
                closeLightbox(state);
                new Notice('File deleted. Gallery is now empty.');
            } else {
                state.currentIndex = Math.min(state.currentIndex, state.mediaFiles.length - 1);
                updateMedia(state, state.fileLink, state.fileMeta);
                updateThumbnails(state);
                new Notice('File deleted successfully.');
            }
            
            if (state.galleryContainer && state.onFileDeleted) {
                setTimeout(() => {
                    state.onFileDeleted();
                }, 100);
            }
            
        } catch (error) {
            console.error('Error deleting file:', error);
            new Notice('Error deleting file: ' + error.message);
        }
    }
}

function updateThumbnails(state) {
    const thumbContainer = document.getElementById('memories-lightbox-thumbnails');
    if (!thumbContainer) return;
    
    thumbContainer.empty();
    
    for (let i = 0; i < state.mediaFiles.length; i++) {
        const file = state.mediaFiles[i];
        const thumb = document.createElement('div');
        thumb.className = 'memories-lightbox-thumb';
        thumb.dataset.index = i;
        
        const resourcePath = state.app.vault.getResourcePath(file);
        
        if (isImage(file.name)) {
            const img = document.createElement('img');
            img.src = resourcePath;
            img.alt = file.name;
            thumb.appendChild(img);
        } else if (isVideo(file.name)) {
            const video = document.createElement('video');
            video.src = resourcePath;
            video.muted = true;
            video.currentTime = 1;
            thumb.appendChild(video);
        } else if (isAudio(file.name)) {
            const audioThumb = document.createElement('div');
            audioThumb.className = 'memories-audio-thumb';
            audioThumb.textContent = '🎵';
            thumb.appendChild(audioThumb);
        }
        
        thumb.addEventListener('click', () => {
            state.currentIndex = i;
            updateMedia(state, state.fileLink, state.fileMeta);
        });

        thumbContainer.appendChild(thumb);
    }
}

function openMediaLightbox(app, mediaFiles, startIndex, onFileDeleted, galleryContainer, lightboxFillWindow) {
    const existing = document.getElementById('memories-lightbox-overlay');
    if (existing) existing.remove();

    const state = {
        currentIndex: startIndex,
        mediaFiles: mediaFiles,
        app: app,
        onFileDeleted: onFileDeleted,
        galleryContainer: galleryContainer,
        lightboxFillWindow: lightboxFillWindow,
        scope: new Scope()
    };

    const overlay = document.createElement('div');
    overlay.id = 'memories-lightbox-overlay';
    if (!lightboxFillWindow) {
        overlay.classList.add('memories-lightbox-dark');
    }

    const topBar = document.createElement('div');
    topBar.className = 'memories-lightbox-topbar';

    const leftControls = document.createElement('div');
    leftControls.className = 'memories-lightbox-controls-left';

    const rightControls = document.createElement('div');
    rightControls.className = 'memories-lightbox-controls-right';

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'memories-lightbox-delete-btn';
    deleteBtn.textContent = '🗑️ Delete file';
    deleteBtn.addEventListener('click', () => deleteCurrentFile(state));

    const fileInfo = document.createElement('div');
    fileInfo.className = 'memories-lightbox-file-info';
    
    const fileLink = document.createElement('a');
    fileLink.className = 'memories-lightbox-file-link';
    fileLink.textContent = mediaFiles[startIndex].name;
    fileLink.href = '#';
    fileLink.addEventListener('click', (e) => {
        e.preventDefault();
        openFileInExplorer(app, state);
    });

    const fileMeta = document.createElement('div');
    fileMeta.className = 'memories-lightbox-file-meta';
    updateFileMeta(fileMeta, mediaFiles[startIndex]);

    fileInfo.appendChild(fileMeta);
    fileInfo.appendChild(fileLink);
    
    const infoDiv = document.createElement('div');
    infoDiv.className = 'memories-lightbox-close-box';
    infoDiv.addEventListener('click', () => closeLightbox(state));

    const closeBtn = document.createElement('button');
    closeBtn.className = 'memories-lightbox-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => closeLightbox(state));

    rightControls.appendChild(fileInfo);
    rightControls.appendChild(deleteBtn);
    infoDiv.appendChild(closeBtn);
    rightControls.appendChild(infoDiv);

    topBar.appendChild(leftControls);
    topBar.appendChild(rightControls);

    const mainArea = document.createElement('div');
    mainArea.className = 'memories-lightbox-main';

    const mediaContainer = document.createElement('div');
    mediaContainer.className = 'memories-lightbox-media-container';
    mediaContainer.id = 'memories-lightbox-media-container';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'memories-lightbox-nav memories-lightbox-prev';
    const prevArrow = document.createElement('span');
    prevArrow.textContent = '‹';
    prevBtn.appendChild(prevArrow);
    prevBtn.addEventListener('click', () => navigate(state, -1));

    const nextBtn = document.createElement('button');
    nextBtn.className = 'memories-lightbox-nav memories-lightbox-next';
    const nextArrow = document.createElement('span');
    nextArrow.textContent = '›';
    nextBtn.appendChild(nextArrow);
    nextBtn.addEventListener('click', () => navigate(state, 1));

    mainArea.appendChild(prevBtn);
    mainArea.appendChild(mediaContainer);
    mainArea.appendChild(nextBtn);

    const thumbContainer = document.createElement('div');
    thumbContainer.className = 'memories-lightbox-thumbnails';
    thumbContainer.id = 'memories-lightbox-thumbnails';

    for (let i = 0; i < mediaFiles.length; i++) {
        const file = mediaFiles[i];
        const thumb = document.createElement('div');
        thumb.className = 'memories-lightbox-thumb';
        thumb.dataset.index = i;

        const resourcePath = app.vault.getResourcePath(file);

        if (isImage(file.name)) {
            const img = document.createElement('img');
            img.src = resourcePath;
            img.alt = file.name;
            thumb.appendChild(img);
        } else if (isVideo(file.name)) {
            const video = document.createElement('video');
            video.src = resourcePath;
            video.muted = true;
            video.currentTime = 1;
            thumb.appendChild(video);
        } else if (isAudio(file.name)) {
            const audioThumb = document.createElement('div');
            audioThumb.className = 'memories-audio-thumb';
            audioThumb.textContent = '🎵';
            thumb.appendChild(audioThumb);
        }

        thumb.addEventListener('click', () => {
            state.currentIndex = i;
            updateMedia(state, fileLink, fileMeta);
        });

        thumbContainer.appendChild(thumb);
    }

    let isDragging = false;
    let startX;
    let scrollLeft;

    thumbContainer.addEventListener('mousedown', (e) => {
        isDragging = true;
        thumbContainer.classList.add('dragging');
        startX = e.pageX - thumbContainer.offsetLeft;
        scrollLeft = thumbContainer.scrollLeft;
    });

    thumbContainer.addEventListener('mouseleave', () => {
        isDragging = false;
        thumbContainer.classList.remove('dragging');
    });

    thumbContainer.addEventListener('mouseup', () => {
        isDragging = false;
        thumbContainer.classList.remove('dragging');
    });

    thumbContainer.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        e.preventDefault();
        const x = e.pageX - thumbContainer.offsetLeft;
        const walk = (x - startX) * 2;
        thumbContainer.scrollLeft = scrollLeft - walk;
    });

    thumbContainer.addEventListener('wheel', (e) => {
        e.preventDefault();
        thumbContainer.scrollLeft += e.deltaY * 2;
        
        thumbContainer.classList.add('scrolling');
        clearTimeout(thumbContainer.scrollTimeout);
        thumbContainer.scrollTimeout = setTimeout(() => {
            thumbContainer.classList.remove('scrolling');
        }, 150);
    });
    
    thumbContainer.addEventListener('click', (e) => {
        if (isDragging) {
            e.preventDefault();
            e.stopPropagation();
        }
    });

    overlay.appendChild(topBar);
    overlay.appendChild(mainArea);
    overlay.appendChild(thumbContainer);
    document.body.appendChild(overlay);

    state.fileLink = fileLink;
    state.fileMeta = fileMeta;

    updateMedia(state, fileLink, fileMeta);

    state.scope.register([], 'ArrowLeft', () => { navigate(state, -1); return false; });
    state.scope.register([], 'ArrowRight', () => { navigate(state, 1); return false; });
    state.scope.register([], 'Escape', () => { closeLightbox(state); return false; });

    const wheelHandler = (e) => {
        if (document.querySelector('img:hover, video:hover')) return;
        e.preventDefault();
        if (e.deltaY > 0) {
            navigate(state, 1);
        } else if (e.deltaY < 0) {
            navigate(state, -1);
        }
    };

    mainArea.addEventListener('wheel', wheelHandler, { passive: false });

    overlay.dataset.cleanup = 'true';
    overlay.addEventListener('cleanup', () => {
        state.scope.unregister();
        mainArea.removeEventListener('wheel', wheelHandler);
    });
}

function updateFileMeta(fileMeta, file) {
    const fileSize = (file.stat.size / 1024).toFixed(1) + ' KB';
    const modDate = new Date(file.stat.mtime).toLocaleDateString();
    fileMeta.textContent = `${fileSize} • ${modDate}`;
}

function closeLightbox(state) {
    const overlay = document.getElementById('memories-lightbox-overlay');
    if (overlay) {
        overlay.dispatchEvent(new Event('cleanup'));
        overlay.remove();
    }

    if (state && state.galleryContainer && state.onFileDeleted) {
        setTimeout(() => {
            state.onFileDeleted();
        }, 100);
    }
}

function openFileInExplorer(app, state) {
    const file = state.mediaFiles[state.currentIndex];
    if (file) {
        app.showInFolder(file.path);
    }
}

function navigate(state, direction) {
    state.currentIndex = (state.currentIndex + direction + state.mediaFiles.length) % state.mediaFiles.length;
    updateMedia(state, state.fileLink, state.fileMeta);
}

function updateMedia(state, fileLink, fileMeta) {
    const container = document.getElementById('memories-lightbox-media-container');
    if (!container) return;

    container.empty();
    const file = state.mediaFiles[state.currentIndex];
    const resourcePath = state.app.vault.getResourcePath(file);

    if (fileLink) {
        fileLink.textContent = file.name;
        updateFileMeta(fileMeta, file);
    }

    if (isImage(file.name)) {
        const img = document.createElement('img');
        img.src = resourcePath;
        img.alt = file.name;

        let zoomLevel = 1;
        let panX = 0;
        let panY = 0;

        const updateTransform = () => {
            img.style.transform = `scale(${zoomLevel}) translate(${panX}px, ${panY}px)`;
            img.style.cursor = zoomLevel > 1 ? 'move' : 'zoom-in';
        };

        img.addEventListener('click', (e) => {
            e.preventDefault();
            zoomLevel = Math.min(zoomLevel + 1, 5);
            updateTransform();
        });

        img.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            zoomLevel = Math.max(1, zoomLevel - 1);
            if (zoomLevel === 1) {
                panX = 0;
                panY = 0;
            }
            updateTransform();
        });

        const wheelHandler = (e) => {
            if (!document.querySelector('img:hover')) return;
            e.preventDefault();
            
            const delta = e.deltaY < 0 ? 0.2 : -0.2;
            const newZoom = Math.max(1, Math.min(5, zoomLevel + delta));
            
            if (newZoom !== zoomLevel) {
                zoomLevel = newZoom;
                if (zoomLevel === 1) {
                    panX = 0;
                    panY = 0;
                }
                updateTransform();
            }
        };

        img.addEventListener('wheel', wheelHandler, { passive: false });

        img.addEventListener('mousemove', (e) => {
            if (zoomLevel > 1) {
                const rect = container.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;

                const displayWidth = img.offsetWidth;
                const displayHeight = img.offsetHeight;

                const scaledWidth = displayWidth * zoomLevel;
                const scaledHeight = displayHeight * zoomLevel;

                const maxPanX = Math.max(0, (scaledWidth - displayWidth) / 2);
                const maxPanY = Math.max(0, (scaledHeight - displayHeight) / 2);

                const centerX = rect.width / 2;
                const centerY = rect.height / 2;

                const normalizedX = (mouseX - centerX) / centerX;
                const normalizedY = (mouseY - centerY) / centerY;

                const dampingFactor = 1 / Math.sqrt(zoomLevel);

                panX = -normalizedX * maxPanX * dampingFactor;
                panY = -normalizedY * maxPanY * dampingFactor;

                updateTransform();
            }
        });

        img.style.transition = 'transform 0.1s ease-out';
        container.appendChild(img);

    } else if (isVideo(file.name)) {
        const video = document.createElement('video');
        video.src = resourcePath;
        video.controls = true;
        video.autoplay = true;
        video.loop = true;
        container.appendChild(video);

    } else if (isAudio(file.name)) {
        const audioContainer = document.createElement('div');
        audioContainer.className = 'memories-lightbox-audio-container';
        
        const audioIcon = document.createElement('div');
        audioIcon.className = 'memories-lightbox-audio-icon';
        audioIcon.textContent = '🎵';
        
        const audio = document.createElement('audio');
        audio.src = resourcePath;
        audio.controls = true;
        audio.autoplay = true;
        
        const fileName = document.createElement('div');
        fileName.className = 'memories-lightbox-audio-filename';
        fileName.textContent = file.name;
        
        audioContainer.appendChild(audioIcon);
        audioContainer.appendChild(fileName);
        audioContainer.appendChild(audio);
        container.appendChild(audioContainer);
    }

    const thumbs = document.querySelectorAll('.memories-lightbox-thumb');
    thumbs.forEach((thumb, index) => {
        const thumbIndex = parseInt(thumb.dataset.index);
        if (thumbIndex === state.currentIndex) {
            thumb.classList.add('active');
            thumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        } else {
            thumb.classList.remove('active');
        }
    });
}

function isImage(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    return ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'tiff', 'tif', 'avif', 'heic', 'heif', 'ico'].includes(ext);
}

function isVideo(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    return ['mp4', 'webm', 'ogv', 'mov', 'avi', 'mkv', 'flv', 'wmv', '3gp', 'm4v', 'mpg', 'mpeg', 'm2v', 'asf'].includes(ext);
}

function isAudio(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    return ['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'wma', 'opus', 'aiff', 'au'].includes(ext);
}

class MediaGallerySettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
        this.openRuleIndex = null;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('ai-gallery-settings');

        containerEl.createEl('h2', { text: 'AI Gallery 设置' });

        this.renderBasicSection(containerEl);
        this.renderRulesSection(containerEl);
    }

    renderBasicSection(containerEl) {
        const section = containerEl.createEl('div', { cls: 'ai-gallery-settings-section' });
        section.createEl('div', { cls: 'ai-gallery-section-title', text: '基础设置' });
        section.createEl('div', {
            cls: 'ai-gallery-section-desc',
            text: '只保留日常最常用的两个路径设置。'
        });

        new Setting(section)
            .setName('来源目录')
            .setDesc('扫描图片的外部来源目录，例如 Downloads。')
            .addText(text => text
                .setPlaceholder(path.join(os.homedir(), 'Downloads'))
                .setValue(this.plugin.settings.sourceDir || path.join(os.homedir(), 'Downloads'))
                .onChange(async (value) => {
                    this.plugin.settings.sourceDir = value.trim() || path.join(os.homedir(), 'Downloads');
                    await this.plugin.saveSettings();
                }));

        new Setting(section)
            .setName('默认导入文件夹')
            .setDesc('当 memories 代码块没有指定 paths 时使用；如果代码块写了 paths，会优先导入到该 paths。')
            .addText(text => text
                .setPlaceholder('pic')
                .setValue(this.plugin.settings.targetFolder || 'pic')
                .onChange(async (value) => {
                    this.plugin.settings.targetFolder = value.trim() || 'pic';
                    await this.plugin.saveSettings();
                }));

        new Setting(section)
            .setName('灯箱模式 · 自动填充满窗口')
            .setDesc('开启后图片会拉伸填满灯箱窗口；关闭后图片以原始尺寸居中展示，周围使用暗色背景。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.lightboxFillWindow)
                .onChange(async (value) => {
                    this.plugin.settings.lightboxFillWindow = value;
                    await this.plugin.saveSettings();
                }));
    }

    renderRulesSection(containerEl) {
        const section = containerEl.createEl('div', { cls: 'ai-gallery-settings-section' });
        section.createEl('div', { cls: 'ai-gallery-section-title', text: '导入规则' });
        section.createEl('div', {
            cls: 'ai-gallery-section-desc',
            text: '规则默认折叠，只显示名称和前缀；需要修改时再点"编辑"。'
        });

        const rulesList = section.createEl('div', { cls: 'ai-gallery-rule-list' });

        const rules = Array.isArray(this.plugin.settings.importRules)
            ? this.plugin.settings.importRules
            : [];

        if (rules.length === 0) {
            rulesList.createEl('div', {
                cls: 'ai-gallery-empty-rules',
                text: '暂无导入规则。点击下方按钮添加。'
            });
        }

        rules.forEach((rule, index) => {
            this.renderRuleCard(rulesList, rule, index);
        });

        const addBtn = section.createEl('button', {
            text: '+ 添加规则',
            cls: 'ai-gallery-rule-add-btn'
        });

        addBtn.addEventListener('click', async () => {
            this.plugin.settings.importRules.push({
                label: '新规则',
                prefix: '',
                enabled: true
            });
            this.openRuleIndex = this.plugin.settings.importRules.length - 1;
            await this.plugin.saveSettings();
            this.display();
        });
    }

    renderRuleCard(container, rule, index) {
        const card = container.createEl('div', { cls: 'ai-gallery-rule-card' });
        const isOpen = this.openRuleIndex === index;

        if (isOpen) {
            card.addClass('is-open');
        }

        const summary = card.createEl('div', { cls: 'ai-gallery-rule-summary' });

        const meta = summary.createEl('div', { cls: 'ai-gallery-rule-meta' });
        meta.createEl('div', {
            cls: 'ai-gallery-rule-title',
            text: rule.label || '未命名规则'
        });
        meta.createEl('div', {
            cls: 'ai-gallery-rule-prefix',
            text: rule.prefix || '未设置前缀'
        });

        const actions = summary.createEl('div', { cls: 'ai-gallery-rule-actions' });

        const enabledLabel = actions.createEl('label', { cls: 'ai-gallery-rule-toggle-wrap' });
        const enabledInput = enabledLabel.createEl('input', {
            attr: { type: 'checkbox' }
        });
        enabledInput.checked = rule.enabled !== false;
        enabledLabel.createEl('span', { text: '启用' });

        enabledInput.addEventListener('change', async () => {
            this.plugin.settings.importRules[index].enabled = enabledInput.checked;
            await this.plugin.saveSettings();
        });

        const editBtn = actions.createEl('button', {
            text: isOpen ? '收起' : '编辑',
            cls: 'ai-gallery-rule-edit-btn'
        });

        editBtn.addEventListener('click', () => {
            this.openRuleIndex = isOpen ? null : index;
            this.display();
        });

        const deleteBtn = actions.createEl('button', {
            text: '删除',
            cls: 'ai-gallery-rule-delete-btn'
        });

        deleteBtn.addEventListener('click', async () => {
            const name = rule.label || rule.prefix || '未命名规则';
            if (!confirm(`确定删除规则"${name}"吗？`)) return;

            this.plugin.settings.importRules.splice(index, 1);
            this.openRuleIndex = null;
            await this.plugin.saveSettings();
            this.display();
        });

        const editor = card.createEl('div', { cls: 'ai-gallery-rule-editor' });

        const labelRow = editor.createEl('div', { cls: 'ai-gallery-rule-input-row' });
        labelRow.createEl('label', { text: '显示名称' });
        const labelInput = labelRow.createEl('input', {
            attr: { type: 'text', placeholder: '例如：GPT' }
        });
        labelInput.value = rule.label || '';

        labelInput.addEventListener('change', async () => {
            this.plugin.settings.importRules[index].label = labelInput.value.trim();
            await this.plugin.saveSettings();
            this.display();
        });

        const prefixRow = editor.createEl('div', { cls: 'ai-gallery-rule-input-row' });
        prefixRow.createEl('label', { text: '文件名前缀' });
        const prefixInput = prefixRow.createEl('input', {
            attr: { type: 'text', placeholder: '例如：ChatGPT Image ' }
        });
        prefixInput.value = rule.prefix || '';

        prefixInput.addEventListener('change', async () => {
            this.plugin.settings.importRules[index].prefix = prefixInput.value;
            await this.plugin.saveSettings();
            this.display();
        });
    }

}

module.exports = MediaGalleryPlugin;
