/* IndexedDB keeps source audio Blobs and edit metadata together; no audio is uploaded. */
(function (root) {
  'use strict';
  const copy = (value) => value == null ? null : root.structuredClone(value);
  class ProjectStore {
    constructor() { this.db = null; this.memory = new Map(); this.persistent = false; }
    async open() {
      try {
        if (!root.indexedDB) return this;
        this.db = await new Promise((resolve, reject) => {
          const request = root.indexedDB.open('vvcat-audio-cutter', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('projects', { keyPath: 'id' });
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
          request.onblocked = () => reject(new Error('项目数据库被其他页面占用。'));
        });
        this.db.onversionchange = () => { this.db.close(); this.db = null; this.persistent = false; };
        this.persistent = true;
      } catch (_) { this.db = null; }
      return this;
    }
    get(id) {
      if (!this.db) return Promise.resolve(copy(this.memory.get(id)));
      return new Promise((resolve, reject) => {
        const request = this.db.transaction('projects').objectStore('projects').get(id);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    }
    list() {
      if (!this.db) return Promise.resolve([...this.memory.values()].map(copy).sort((a, b) => b.updatedAt - a.updatedAt));
      return new Promise((resolve, reject) => {
        const request = this.db.transaction('projects').objectStore('projects').getAll();
        request.onsuccess = () => resolve(request.result.sort((a, b) => b.updatedAt - a.updatedAt));
        request.onerror = () => reject(request.error);
      });
    }
    put(project) {
      if (!this.db) { this.memory.set(project.id, copy(project)); return Promise.resolve(); }
      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction('projects', 'readwrite');
        transaction.objectStore('projects').put(project);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('项目保存失败。'));
        transaction.onabort = () => reject(transaction.error || new Error('项目保存被中断。'));
      });
    }
  }
  if (typeof module === 'object' && module.exports) module.exports = ProjectStore;
  else root.AudioCutterProjectStore = ProjectStore;
})(globalThis);
