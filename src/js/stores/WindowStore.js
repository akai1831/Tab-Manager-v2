import { action, computed, observable } from 'mobx'
import {
  moveTabs,
  getLastFocusedWindowId,
  notSelfPopup,
  windowComparator,
  isSelfPopup
} from 'libs'
import actions from 'libs/actions'
import Window from 'stores/Window'
import Tab from 'stores/Tab'
import Column from 'stores/Column'

const DEBOUNCE_INTERVAL = 1000

export default class WindowsStore {
  constructor (store) {
    this.store = store
  }

  didMount = () => {
    this.getAllWindows()
    // chrome.windows.onCreated.addListener(this.updateAllWindows)
    chrome.windows.onFocusChanged.addListener(this.onFocusChanged)
    // chrome.windows.onRemoved.addListener(this.updateAllWindows)

    chrome.tabs.onCreated.addListener(this.onCreated)
    chrome.tabs.onUpdated.addListener(this.onUpdated)
    chrome.tabs.onActivated.addListener(this.onActivated)
    chrome.tabs.onRemoved.addListener(this.onRemoved)

    // Move tabs related functions, use `updateAllWindows` to keep clean.
    chrome.tabs.onMoved.addListener(this.updateAllWindows)
    chrome.tabs.onAttached.addListener(this.updateAllWindows)
    chrome.tabs.onDetached.addListener(this.updateAllWindows)
    chrome.tabs.onReplaced.addListener(this.updateAllWindows)
  }

  @observable windows = []
  @observable columns = []
  @observable initialLoading = true
  @observable lastFocusedWindowId = null

  height = 600

  lastCallTime = 0
  updateHandler = null
  batching = false

  @computed
  get tabCount () {
    return this.windows
      .map(x => x.tabs.length)
      .reduce((acc, cur) => acc + cur, 0)
  }

  @computed
  get tabs () {
    return [].concat(...this.windows.map(x => x.tabs.slice()))
  }

  clearWindow = () => {
    this.columns.forEach(x => x.clearWindow())
    for (let index = 0; index < this.columns.length;) {
      if (this.columns[index].length === 0) {
        this.columns.splice(index, 1)
      } else {
        index++
      }
    }
  }

  @action
  onRemoved = (id, { windowId, isWindowClosing }) => {
    this.removeTabs([id])
    this.store.tabStore.selection.delete(id)
    this.clearWindow()
  }

  @action
  onUpdated = (tabId, changeInfo, newTab) => {
    const tab = this.tabs.find(x => x.id === tabId)
    if (tab) {
      Object.assign(tab, newTab)
      tab.setUrlIcon()
    }
  }

  onFocusChanged = windowId => {
    if (windowId <= 0) {
      return
    }
    chrome.windows.get(windowId, { populate: true }, win => {
      if (win && !isSelfPopup(win)) {
        this.lastFocusedWindowId = windowId
      }
    })
  }

  @action
  onCreated = tab => {
    const { index, windowId } = tab
    const win = this.windows.find(x => x.id === windowId)
    if (!win) {
      this.windows.push(new Window({ id: windowId, tabs: [tab] }, this.store))
    } else {
      win.add(new Tab(tab, this.store, win), index)
    }
    this.updateColumns()
  }

  @action
  onActivated = ({ tabId, windowId }) => {
    this.lastFocusedWindowId = windowId
    const win = this.windows.find(x => x.id === windowId)
    if (!win) {
      return
    }
    win.tabs.forEach(tab => {
      if (tab.active && tab.id !== tabId) {
        tab.active = false
      }
    })
    const tab = win.tabs.find(x => x.id === tabId)
    if (tab) {
      tab.active = true
    }
  }

  suspend = () => {
    this.batching = true
  }

  resume = () => {
    if (this.updateHandler != null) {
      clearTimeout(this.updateHandler)
    }
    this.batching = false
    this.getAllWindows()
  }

  @action
  removeTabs = ids => {
    const set = new Set(ids)
    this.windows.forEach(win => win.removeTabs(set))
    this.clearWindow()
  }

  @action
  createNewWindow = tabs => {
    this.suspend()
    this.removeTabs(tabs.map(x => x.id))
    const win = new Window({ tabs: [] }, this.store)
    win.tabs = tabs
    this.windows.push(win)
    this.clearWindow()
    chrome.runtime.sendMessage(
      {
        tabs: tabs.map(({ id, pinned }) => ({ id, pinned })),
        action: actions.createWindow
      },
      this.resume
    )
  }

  @action
  updateAllWindows = () => {
    const time = Date.now()
    if (this.updateHandler != null) {
      clearTimeout(this.updateHandler)
    }
    if (time - this.lastCallTime < DEBOUNCE_INTERVAL) {
      this.updateHandler = setTimeout(this.getAllWindows, DEBOUNCE_INTERVAL)
    } else {
      this.getAllWindows()
    }
    this.lastCallTime = time
  }

  @action selectAll = () => this.store.tabStore.selectAll(this.tabs)

  @action
  windowMounted = () => {
    const win = this.windows.find(x => !x.showTabs)
    if (win) {
      win.showTabs = true
      win.tabMounted()
    }
  }

  @computed
  get lastFocusedWindow () {
    return this.windows.find(x => x.lastFocused)
  }

  @computed
  get urlCountMap () {
    return this.tabs.reduce((acc, tab) => {
      const { url } = tab
      acc[url] = (acc[url] || 0) + 1
      return acc
    }, {})
  }

  @computed
  get duplicatedTabs () {
    return this.tabs.filter(tab => this.urlCountMap[tab.url] > 1)
  }

  @action
  closeDuplicatedTab = tab => {
    const { id, url } = tab
    this.tabs.filter(x => x.url === url && x.id !== id).forEach(x => x.remove())
  }

  @action
  cleanDuplicatedTabs = () => {
    const tabMap = this.duplicatedTabs.reduce((acc, tab) => {
      const { url } = tab
      if (acc[url]) {
        acc[url].push(tab)
      } else {
        acc[url] = [tab]
      }
      return acc
    }, {})
    Object.values(tabMap).map(tabs => {
      tabs.slice(1).forEach(x => x.remove())
    })
  }

  getTargetWindow = windowId => {
    const win = this.windows.find(win => win.id === windowId)
    if (!win) {
      throw new Error(
        `getTargetWindow canot find window for windowId: ${windowId}!`
      )
    }
    return win
  }

  @action
  moveTabs = async (tabs, windowId, from = 0) => {
    const targetWindow = this.getTargetWindow(windowId)
    tabs.map((tab, i) => {
      const index = from + (from !== -1 ? i : 0)
      const sourceWindow = this.getTargetWindow(tab.windowId)
      sourceWindow.remove(tab)
      targetWindow.add(tab, index)
    })
    this.clearWindow()
    await moveTabs(tabs, windowId, from)
  }

  @action
  updateHeight (height) {
    if (this.height !== height) {
      this.height = height
      this.updateColumns()
    }
  }

  @action
  updateColumns () {
    const max = Math.ceil(this.height / 35 * 1.6)
    this.columns = this.windows.filter(x => x.length > 0).reduce(
      (acc, cur) => {
        const column = acc[acc.length - 1]
        if (column.length === 0 || column.length + cur.length <= max) {
          column.add(cur)
        } else {
          acc.push(new Column(this.store, cur))
        }
        return acc
      },
      [new Column(this.store)]
    )
  }

  getAllWindows = () => {
    if (this.batching) {
      return
    }
    chrome.windows.getAll({ populate: true }, async (windows = []) => {
      this.lastFocusedWindowId = await getLastFocusedWindowId()

      this.windows = windows
        .filter(notSelfPopup)
        .map(win => new Window(win, this.store))
        .sort(windowComparator)

      if (this.initialLoading) {
        this.windowMounted()
      } else {
        this.updateColumns()
      }
      this.initialLoading = false
      this.updateHandler = null
    })
  }
}
