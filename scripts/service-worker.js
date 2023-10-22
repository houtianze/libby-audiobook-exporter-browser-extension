import { Commands, getTailAfter, base64UrlDecode, makePathNameSafe, delayRoughlyMs } from './common.js'

// globals
// { titleId: {
//    "titleId": titleId,
//    "tile": title,
//    "downloadDir": downloadDir,
//    "openbookUrl": openbook_json_url,
//    "coverUrl": cover_url,
//    ...
//    "audios": {
//       mp3SaveFileName: mp3Url
//     }
//   }
// }
let books = {}

async function loadBookFromStorage() {
    const books = await chrome.storage.session.get('books') ?? {}
    removeExpiredBooks()
    chrome.storage.session.set(books)
    function removeExpiredBooks() {
        Object.keys(books).forEach(
            titleId => {
                if (books[titleId]?.expiresAt < Date.now()) {
                    delete books[titleId]
                }
            }
        )
    }

}

async function retrieveBooks(passportTitles) {
    for (const titleId of Object.keys(passportTitles)) {
        await retrieveBookInfo(titleId)
        await delayRoughlyMs(200)
    }

    async function retrieveBookInfo(titleId) {
        const passport = passportTitles[titleId].passport
        const titleProp = passportTitles[titleId].title
        const openbookUrl = passport?.urls?.openbook
        const openbookResponse = await fetch(openbookUrl)
        const openbook = await openbookResponse.json()

        const book = {}
        books[titleId] = book
        book.expiresAt = passport.expiresAt
        book.titleId = titleId
        book.title = titleProp?.title
        book.subtitle = titleProp?.subtitle
        book.downloadDir = makePathNameSafe(book.title)
        book.creators = titleProp?.creators
        book.coverUrl = titleProp?.cover?.url
        book.metaFiles = {}
        book.metaFiles['openbook.json'] = { url: openbookUrl, downloaded: false }
        const coverFilename = `cover.${getTailAfter(book.coverUrl, '.')?.toLowerCase() ?? 'jpg'}`
        book.metaFiles[coverFilename] = { url: book.coverUrl, downloaded: false }
        const baseUrl = passport.urls.web.endsWith('/') ? passport.urls.web : passport.urls.web + '/'
        const mp3Urls = openbook?.spine?.map(
            x => `${baseUrl}${x.path}`
        )
        book.audios = {}
        mp3Urls.forEach(
            (mp3Url, i) => {
                const match = mp3Url.match(/-[P|p]art\d*\..*?\?/)
                const suffix = match?.[0]?.slice(0, -1) ?? ("-Part" + (i > 9 ? i : "0" + i) + ".mp3")
                const filename = `${book.downloadDir}${suffix}`
                book.audios[filename] = { url: mp3Url, downloaded: false }
            }
        )
        book.downloading = false
        chrome.storage.session.set(books)
    }
}

async function download(titleId) {
    if (!books?.[titleId]) {
        return null
    }

    const book = books[titleId]
    if (book.downloading) {
        return book
    }

    book.downloading = true
    console.log(`[lae] start downloading "${book?.title}".`)
    await downloadFiles(book.metaFiles, book)
    await downloadFiles(book.audios, book)
    console.log(`[lae] finish downloading "${book?.title}".`)
    book.downloading = false
    Object.keys(book.metaFiles).forEach(filename => book.metaFiles[filename].downloaded = false)
    Object.keys(book.audios).forEach(filename => book.audios[filename].downloaded = false)
    return book
}

async function downloadFiles(files, book) {
    for await (const filename of Object.keys(files)) {
        const fileInfo = files[filename];
        console.log(`[lae] downloading ${fileInfo.url} as ${filename}`)
        await chrome.downloads.download({
            url: fileInfo.url,
            filename: `${book.downloadDir}/${filename}`,
        })
        await delayRoughlyMs(5000)
        fileInfo.downloaded = true
        chrome.runtime.sendMessage({ command: Commands.UpdateBook, book: book })
    }
}

async function installedListener(details) {
    // It no longer needs any local storage, clear it up.
    await chrome.storage.local.clear()
}

async function messageListener(message) {
    switch (message?.command) {
        case Commands.ReportBooks:
            await retrieveBooks(message?.books);
            break;
        case Commands.GetBook:
            chrome.runtime.sendMessage({
                command: Commands.UpdateBook,
                book: books[message?.titleId]
            })
            break;
        case Commands.Download:
            download(message.titleId)
            break;
        default:
            console.error(`[lae] Message not understood: ${message}`)
    }
    // https://stackoverflow.com/a/46628145/404271
    return true;
}

async function main() {
    await loadBookFromStorage()
    chrome.runtime.onInstalled.addListener(installedListener)
    chrome.runtime.onMessage.addListener(messageListener)
}

main()
