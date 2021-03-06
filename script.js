"use strict"

const PRODUCTION = process.mainModule.filename.includes("resources")
const path = PRODUCTION ? "./resources/app" : "."

const fs = require("fs")
const {shell, ipcRenderer} = require("electron")
const fetch = require("node-fetch")
const {text_to_sequence, english_cleaners} = require("./text.js")
const {xVAAppLogger} = require("./appLogger.js")
const {saveUserSettings} = require("./settingsMenu.js")

let themeColour
window.appVersion = "v1.0.9"
window.appLogger = new xVAAppLogger(`./app.log`, window.appVersion)
const oldCError = console.error
console.error = (data) => {
    window.appLogger.log(data)
    oldCError(arguments)
}
process.on(`uncaughtException`, data => window.appLogger.log(data))
window.onerror = (err, url, lineNum) => window.appLogger.log(err)

window.addEventListener("error", function (e) {window.appLogger.log(e.error.stack)})
window.addEventListener('unhandledrejection', function (e) {window.appLogger.log(e.reason.stack)})

window.games = {}
window.models = {}
window.pitchEditor = {currentVoice: null, resetPitch: null, resetDurs: null, resetDursMult: null, letterFocus: -1, ampFlatCounter: 0, hasChanged: false, lengthsMult: []}
window.currentModel = undefined
window.currentModelButton = undefined


window.appLogger.log(`Settings: ${JSON.stringify(window.userSettings)}`)

// Set up folders
try {fs.mkdirSync(`${path}/models`)} catch (e) {/*Do nothing*/}
try {fs.mkdirSync(`${path}/output`)} catch (e) {/*Do nothing*/}
try {fs.mkdirSync(`${path}/assets`)} catch (e) {/*Do nothing*/}

// Clean up temp files
fs.readdir(`${__dirname}/output`, (err, files) => {
    if (err) {
        window.appLogger.log(err)
    }
    if (files && files.length) {
        files.filter(f => f.startsWith("temp-")).forEach(file => {
            fs.unlink(`${__dirname}/output/${file}`, err => err&&console.log(err))
        })
    }
})

let fileRenameCounter = 0
let fileChangeCounter = 0
let isGenerating = false

const loadAllModels = () => {
    return new Promise(resolve => {
        fs.readdir(`${path}/models`, (err, gameDirs) => {
            gameDirs.filter(name => !name.includes(".")).forEach(gameFolder => {

                const files = fs.readdirSync(`${path}/models/${gameFolder}`).filter(f => f.endsWith(".json"))

                if (!files.length) {
                    return
                }

                files.forEach(fileName => {

                    if (!models.hasOwnProperty(`${gameFolder}/${fileName}`)) {

                        models[`${gameFolder}/${fileName}`] = null

                        const model = JSON.parse(fs.readFileSync(`${path}/models/${gameFolder}/${fileName}`, "utf8"))
                        model.games.forEach(({gameId, voiceId, voiceName, voiceDescription, gender}) => {

                            if (!games.hasOwnProperty(gameId)) {

                                const gameAsset = fs.readdirSync(`${path}/assets`).find(f => f.startsWith(gameId))
                                const option = document.createElement("option")
                                option.value = gameAsset
                                option.innerHTML = gameAsset.split("-").reverse()[0].split(".")[0]
                                games[gameId] = {
                                    models: [],
                                    gameAsset
                                }

                                // Insert the dropdown option, in alphabetical order, except for Other
                                const existingOptions = Array.from(gameDropdown.childNodes)

                                if (existingOptions.length && option.innerHTML!="Other") {
                                    const afterElement = existingOptions.find(el => el.text>option.innerHTML || el.text=="Other")
                                    gameDropdown.insertBefore(option, afterElement)
                                } else {
                                    gameDropdown.appendChild(option)
                                }
                            }

                            const audioPreviewPath = `${gameFolder}/${model.games.find(({gameId}) => gameId==gameFolder).voiceId}`
                            const existingDuplicates = []
                            games[gameId].models.forEach((item,i) => {
                                if (item.voiceId==voiceId) {
                                    existingDuplicates.push([item, i])
                                }
                            })
                            if (existingDuplicates.length) {
                                if (existingDuplicates[0][0].modelVersion<model.modelVersion) {
                                    games[gameId].models.splice(existingDuplicates[0][1], 1)
                                    games[gameId].models.push({model, audioPreviewPath, gameId, voiceId, voiceName, voiceDescription, gender, modelVersion: model.modelVersion})
                                }
                            } else {
                                games[gameId].models.push({model, audioPreviewPath, gameId, voiceId, voiceName, voiceDescription, gender, modelVersion: model.modelVersion})
                            }
                        })
                    }
                })
            })

            resolve()
        })
    })
}

// Change game
const changeGame = () => {

    const meta = gameDropdown.value.split("-")
    themeColour = meta[1]
    generateVoiceButton.disabled = true
    generateVoiceButton.innerHTML = "Generate Voice"

    // Change the app title
    if (meta[2]) {
        document.title = `${meta[2]}VA Synth`
        dragBar.innerHTML = `${meta[2]}VA Synth`
    } else {
        document.title = `xVA Synth`
        dragBar.innerHTML = `xVA Synth`
    }

    if (meta) {
        const background = `linear-gradient(0deg, grey 0px, rgba(0,0,0,0)), url("assets/${meta.join("-")}")`
        Array.from(document.querySelectorAll("button")).forEach(e => e.style.background = `#${themeColour}`)
        Array.from(document.querySelectorAll(".voiceType")).forEach(e => e.style.background = `#${themeColour}`)
        Array.from(document.querySelectorAll(".spinner")).forEach(e => e.style.borderLeftColor = `#${themeColour}`)

        // Fade the background image transition
        rightBG1.style.background = background
        rightBG2.style.opacity = 0
        setTimeout(() => {
            rightBG2.style.background = rightBG1.style.background
            rightBG2.style.opacity = 1
        }, 1000)
    }

    cssHack.innerHTML = `::selection {
        background: #${themeColour};
    }
    ::-webkit-scrollbar-thumb {
        background-color: #${themeColour} !important;
    }
    .slider::-webkit-slider-thumb {
        background-color: #${themeColour} !important;
    }
    `

    try {fs.mkdirSync(`${path}/output/${meta[0]}`)} catch (e) {/*Do nothing*/}
    localStorage.setItem("lastGame", gameDropdown.value)

    // Populate models
    voiceTypeContainer.innerHTML = ""
    voiceSamples.innerHTML = ""
    title.innerHTML = "Select Voice Type"

    // No models found
    if (!Object.keys(games).length) {
        title.innerHTML = "No models found"
        return
    }

    const buttons = []

    games[meta[0]].models.forEach(({model, audioPreviewPath, gameId, voiceId, voiceName, voiceDescription}) => {

        const button = createElem("div.voiceType", voiceName)
        button.style.background = `#${themeColour}`
        button.dataset.modelId = voiceId

        // Quick voice set preview, if there is a preview file
        button.addEventListener("contextmenu", () => {
            window.appLogger.log(`${path}/models/${audioPreviewPath}.wav`)
            const audioPreview = createElem("audio", {autoplay: false}, createElem("source", {
                src: `./models/${audioPreviewPath}.wav`
            }))
        })

        button.addEventListener("click", () => {

            window.currentModel = model
            window.currentModelButton = button

            if (voiceDescription) {
                description.innerHTML = voiceDescription
                description.className = "withContent"
            } else {
                description.innerHTML = ""
                description.className = ""
            }

            generateVoiceButton.dataset.modelQuery = null

            // The model is already loaded. Don't re-load it.
            if (generateVoiceButton.dataset.modelIDLoaded == voiceId) {
                generateVoiceButton.innerHTML = "Generate Voice"
                generateVoiceButton.dataset.modelQuery = "null"

            } else {
                generateVoiceButton.innerHTML = "Load model"

                const modelGameFolder = audioPreviewPath.split("/")[0]
                const modelFileName = audioPreviewPath.split("/")[1].split(".wav")[0]

                generateVoiceButton.dataset.modelQuery = JSON.stringify({
                    outputs: parseInt(model.outputs),
                    model: `${path}/models/${modelGameFolder}/${modelFileName}`,
                    model_speakers: model.emb_size,
                    cmudict: model.cmudict
                })
                generateVoiceButton.dataset.modelIDToLoad = voiceId
            }
            generateVoiceButton.disabled = false

            title.innerHTML = button.innerHTML
            title.dataset.modelId = voiceId
            keepSampleButton.style.display = "none"
            samplePlay.style.display = "none"

            // Voice samples
            voiceSamples.innerHTML = ""
            fs.readdir(`${window.userSettings[`outpath_${meta[0]}`]}/${button.dataset.modelId}`, (err, files) => {

                if (err) return

                files.forEach(file => {
                    voiceSamples.appendChild(makeSample(`${window.userSettings[`outpath_${meta[0]}`]}/${button.dataset.modelId}/${file}`))
                })
            })
        })
        buttons.push(button)
    })

    buttons.sort((a,b) => a.innerHTML<b.innerHTML?-1:1)
        .forEach(button => voiceTypeContainer.appendChild(button))

}

const makeSample = (src, newSample) => {
    const fileName = src.split("/").reverse()[0].split("%20").join(" ")
    const fileFormat = fileName.split(".")[1]
    const sample = createElem("div.sample", createElem("div", fileName))
    const audioControls = createElem("div")
    const audio = createElem("audio", {controls: true}, createElem("source", {
        src: src,
        type: `audio/${fileFormat}`
    }))
    const openFileLocationButton = createElem("div", "&#10064;")
    openFileLocationButton.addEventListener("click", () => {
        console.log("open dir", src)
        shell.showItemInFolder(src)
    })

    const renameButton = createElem("div", `<svg class="renameSVG" version="1.0" xmlns="http:\/\/www.w3.org/2000/svg" width="344.000000pt" height="344.000000pt" viewBox="0 0 344.000000 344.000000" preserveAspectRatio="xMidYMid meet"><g transform="translate(0.000000,344.000000) scale(0.100000,-0.100000)" fill="#555555" stroke="none"><path d="M1489 2353 l-936 -938 -197 -623 c-109 -343 -195 -626 -192 -629 2 -3 284 84 626 193 l621 198 937 938 c889 891 937 940 934 971 -11 108 -86 289 -167 403 -157 219 -395 371 -655 418 l-34 6 -937 -937z m1103 671 c135 -45 253 -135 337 -257 41 -61 96 -178 112 -241 l12 -48 -129 -129 -129 -129 -287 287 -288 288 127 127 c79 79 135 128 148 128 11 0 55 -12 97 -26z m-1798 -1783 c174 -79 354 -248 436 -409 59 -116 72 -104 -213 -196 l-248 -80 -104 104 c-58 58 -105 109 -105 115 0 23 154 495 162 495 5 0 37 -13 72 -29z"/></g></svg>`)
    renameButton.addEventListener("click", () => {
        createModal("prompt", {
            prompt: "Enter new file name, or submit unchanged to cancel.",
            value: sample.querySelector("div").innerHTML+`.${fileFormat}`
        }).then(newFileName => {
            if (newFileName!=fileName) {
                const oldPath = src.split("/").reverse()
                const newPath = src.split("/").reverse()
                oldPath[0] = sample.querySelector("div").innerHTML+`.${fileFormat}`
                newPath[0] = newFileName
                fs.renameSync(oldPath.reverse().join("/"), newPath.reverse().join("/"))
                sample.querySelector("div").innerHTML = newFileName.split(`.${fileFormat}`)[0]
            }
        })
    })

    const deleteFileButton = createElem("div", "&#10060;")
    deleteFileButton.addEventListener("click", () => {
        confirmModal(`Are you sure you'd like to delete this file?<br><br><i>${fileName}</i>`).then(confirmation => {
            if (confirmation) {
                window.appLogger.log(`Deleting${newSample?"new":" "} file: ${src}`)
                fs.unlinkSync(src)
                sample.remove()
            }
        })
    })
    audioControls.appendChild(renameButton)
    audioControls.appendChild(audio)
    audioControls.appendChild(openFileLocationButton)
    audioControls.appendChild(deleteFileButton)
    sample.appendChild(audioControls)
    return sample
}


window.toggleSpinnerButtons = () => {
    const spinnerVisible = window.getComputedStyle(spinner).display == "block"
    spinner.style.display = spinnerVisible ? "none" : "block"
    keepSampleButton.style.display = spinnerVisible ? "block" : "none"
    generateVoiceButton.style.display = spinnerVisible ? "block" : "none"
    samplePlay.style.display = spinnerVisible ? "flex" : "none"
}

generateVoiceButton.addEventListener("click", () => {

    const game = gameDropdown.value.split("-")[0]

    try {fs.mkdirSync(window.userSettings[`outpath_${game}`])} catch (e) {/*Do nothing*/}
    try {fs.mkdirSync(`${window.userSettings[`outpath_${game}`]}/${voiceId}`)} catch (e) {/*Do nothing*/}


    if (generateVoiceButton.dataset.modelQuery && generateVoiceButton.dataset.modelQuery!="null") {

        window.appLogger.log(`Loading voice set: ${JSON.parse(generateVoiceButton.dataset.modelQuery).model}`)

        spinnerModal("Loading voice set<br>(may take a minute...)")
        fetch(`http://localhost:8008/loadModel`, {
            method: "Post",
            body: generateVoiceButton.dataset.modelQuery
        }).then(r=>r.text()).then(res => {
            closeModal().then(() => {
                generateVoiceButton.dataset.modelQuery = null
                generateVoiceButton.innerHTML = "Generate Voice"
                generateVoiceButton.dataset.modelIDLoaded = generateVoiceButton.dataset.modelIDToLoad
            })
        }).catch(e => {
            console.log(e)
            if (e.code =="ENOENT") {
                closeModal().then(() => {
                    createModal("error", "There was an issue connecting to the python server.<br><br>Try again in a few seconds. If the issue persists, make sure localhost port 8008 is free, or send the server.log file to me on GitHub or Nexus.")
                })
            }
        })
    } else {

        if (isGenerating) {
            return
        }
        isGenerating = true

        const sequence = dialogueInput.value.trim()
        if (sequence.length==0) {
            return
        }

        const existingSample = samplePlay.querySelector("audio")
        if (existingSample) {
            existingSample.pause()
        }

        toggleSpinnerButtons()

        const voiceType = title.dataset.modelId
        const outputFileName = dialogueInput.value.slice(0, 260).replace(/\n/g, " ").replace(/[\/\\:\*?<>"|]*/g, "")

        try {fs.unlinkSync(localStorage.getItem("tempFileLocation"))} catch (e) {/*Do nothing*/}

        // For some reason, the samplePlay audio element does not update the source when the file name is the same
        const tempFileNum = `${Math.random().toString().split(".")[1]}`
        const tempFileLocation = `${path}/output/temp-${tempFileNum}.wav`
        let pitch = []
        let duration = []
        let quick_n_dirty = false
        let isFreshRegen = true

        if (editor.innerHTML && editor.innerHTML.length && window.pitchEditor.sequence && sequence==window.pitchEditor.inputSequence
            && generateVoiceButton.dataset.modelIDLoaded==window.pitchEditor.currentVoice) {
            pitch = window.pitchEditor.pitchNew
            duration = window.pitchEditor.dursNew
            isFreshRegen = false
        }
        quick_n_dirty = window.userSettings.quick_n_dirty
        window.pitchEditor.currentVoice = generateVoiceButton.dataset.modelIDLoaded

        const speaker_i = window.currentModel.games[0].emb_i

        window.appLogger.log(`Synthesising audio: ${sequence}`)
        fetch(`http://localhost:8008/synthesize`, {
            method: "Post",
            body: JSON.stringify({
                sequence, pitch, duration, speaker_i,
                outfile: tempFileLocation,
                hifi_gan: !!quick_n_dirty
            })
        }).then(r=>r.text()).then(res => {
            isGenerating = false
            res = res.split("\n")
            let pitchData = res[0]
            let durationsData = res[1]
            let cleanedSequence = res[2]
            pitchData = pitchData.split(",").map(v => parseFloat(v))
            durationsData = durationsData.split(",").map(v => parseFloat(v))
            window.pitchEditor.inputSequence = sequence
            window.pitchEditor.sequence = cleanedSequence

            if (pitch.length==0 || isFreshRegen) {
                window.pitchEditor.ampFlatCounter = 0
                window.pitchEditor.resetPitch = pitchData
                window.pitchEditor.resetDurs = durationsData
                window.pitchEditor.resetDursMult = window.pitchEditor.resetDurs.map(v=>1)
            }

            setPitchEditorValues(cleanedSequence.replace(/\s/g, "_").split(""), pitchData, durationsData, isFreshRegen)

            toggleSpinnerButtons()
            keepSampleButton.dataset.newFileLocation = `${window.userSettings[`outpath_${game}`]}/${voiceType}/${outputFileName}.wav`
            keepSampleButton.disabled = false
            samplePlay.dataset.tempFileLocation = tempFileLocation
            samplePlay.innerHTML = ""

            const finalOutSrc = `./output/temp-${tempFileNum}.wav`.replace("..", ".")

            const audio = createElem("audio", {controls: true, style: {width:"150px"}},
                    createElem("source", {src: finalOutSrc, type: "audio/wav"}))
            samplePlay.appendChild(audio)
            audio.load()
            if (window.userSettings.autoPlayGen) {
                audio.play()
            }

            // Persistance across sessions
            localStorage.setItem("tempFileLocation", tempFileLocation)
        }).catch(res => {
            isGenerating = false
            console.log(res)
            window.errorModal(`Something went wrong`)
            toggleSpinnerButtons()
        })
    }
})

const saveFile = (from, to) => {
    to = to.split("%20").join(" ")
    to = to.replace(".wav", `.${window.userSettings.audio.format}`)

    // Make the containing folder if it does not already exist
    let containerFolderPath = to.split("/")
    containerFolderPath = containerFolderPath.slice(0,containerFolderPath.length-1).join("/")

    try {fs.mkdirSync(containerFolderPath)} catch (e) {/*Do nothing*/}

    if (window.userSettings.audio.ffmpeg) {
        spinnerModal("Saving the audio file...")
        const options = {
            hz: window.userSettings.audio.hz,
            padStart: window.userSettings.audio.padStart,
            padEnd: window.userSettings.audio.padEnd,
            bit_depth: window.userSettings.audio.bitdepth
        }

        window.appLogger.log(`About to save file from ${from} to ${to} with options: ${JSON.stringify(options)}`)
        fetch(`http://localhost:8008/outputAudio`, {
            method: "Post",
            body: JSON.stringify({
                input_path: from,
                output_path: to,
                options: JSON.stringify(options)
            })
        }).then(r=>r.text()).then(res => {
            closeModal().then(() => {
                if (res.length) {
                    console.log("res", res)
                    window.errorModal(`Something went wrong<br><br>Input: ${from}<br>Output: ${to}<br><br>${res}`)
                } else {
                    voiceSamples.appendChild(makeSample(to, true))
                    keepSampleButton.disabled = true
                }
            })
        }).catch(res => {
            window.appLogger.log(res)
            console.log("CATCH res", res)
            closeModal().then(() => {
                window.errorModal(`Something went wrong<br><br>Input: ${from}<br>Output: ${to}<br><br>${res}`)
            })
        })
    } else {
        fs.copyFile(from, to, err => {
            if (err) {
                console.log(err)
                window.appLogger.log(err)
            }
            voiceSamples.appendChild(makeSample(to, true))
            keepSampleButton.disabled = true
        })
    }

}
keepSampleButton.addEventListener("click", () => {
    if (keepSampleButton.dataset.newFileLocation) {

        let fromLocation = samplePlay.dataset.tempFileLocation
        let toLocation = keepSampleButton.dataset.newFileLocation

        toLocation = toLocation.split("/")
        toLocation[toLocation.length-1] = toLocation[toLocation.length-1].replace(/[\/\\:\*?<>"|]*/g, "")
        toLocation = toLocation.join("/")

        // File name conflict
        if (fs.existsSync(toLocation)) {

            createModal("prompt", {
                prompt: "File already exists. Adjust the file name here, or submit without changing to overwrite the old file.",
                value: toLocation.split("/").reverse()[0]
            }).then(newFileName => {

                let toLocationOut = toLocation.split("/").reverse()
                toLocationOut[0] = newFileName.replace(`.${window.userSettings.audio.format}`, "") + `.${window.userSettings.audio.format}`
                let outDir = toLocationOut
                outDir.shift()

                const existingFiles = fs.readdirSync(outDir.reverse().join("/"))
                newFileName = (newFileName.replace(`.${window.userSettings.audio.format}`, "") + `.${window.userSettings.audio.format}`).replace(/[\/\\:\*?<>"|]*/g, "")
                const existingFileConflict = existingFiles.filter(name => name==newFileName)

                toLocationOut.push(newFileName)

                const finalOutLocation = toLocationOut.join("/")

                if (existingFileConflict.length) {
                    // Remove the entry from the output files' preview
                    Array.from(voiceSamples.querySelectorAll("div.sample")).forEach(sampleElem => {
                        const source = sampleElem.querySelector("source")
                        let sourceSrc = source.src.split("%20").join(" ").replace("file:///", "")
                        sourceSrc = sourceSrc.split("/").reverse()
                        const finalFileName = finalOutLocation.split("/").reverse()

                        if (sourceSrc[0] == finalFileName[0]) {
                            sampleElem.parentNode.removeChild(sampleElem)
                        }
                    })

                    // Remove the old file and write the new one in
                    fs.unlink(finalOutLocation, err => {
                        if (err) {
                            console.log(err)
                            window.appLogger.log(err)
                        }
                        console.log(fromLocation, "finalOutLocation", finalOutLocation)
                        saveFile(fromLocation, finalOutLocation)
                    })

                } else {
                    saveFile(fromLocation, toLocationOut.join("/"))
                }
            })

        } else {
            console.log("fromLocation", fromLocation)
            console.log("toLocation", toLocation)
            saveFile(fromLocation, toLocation)
        }
    }
})


gameDropdown.addEventListener("change", changeGame)


let startingSplashInterval
let loadingStage = 0
startingSplashInterval = setInterval(() => {
    if (fs.existsSync(`${path}/FASTPITCH_LOADING`)) {
        if (loadingStage==0) {
            spinnerModal("Loading...<br>May take a minute<br><br>Building FastPitch model...")
            loadingStage = 1
        }
    } else if (fs.existsSync(`${path}/WAVEGLOW_LOADING`)) {
        if (loadingStage==1) {
            activeModal.children[0].innerHTML = "Loading...<br>May take a minute<br><br>Loading WaveGlow model..."
            loadingStage = 2
        }
    } else if (fs.existsSync(`${path}/SERVER_STARTING`)) {
        if (loadingStage==2) {
            activeModal.children[0].innerHTML = "Loading...<br>May take a minute<br><br>Starting up the python backend..."
            loadingStage = 3
        }
    } else {
        closeModal().then(() => {
            clearInterval(startingSplashInterval)
        })
    }
}, 100)

loadAllModels().then(() => {
    // Load the last selected game
    const lastGame = localStorage.getItem("lastGame")

    if (lastGame) {
        gameDropdown.value = lastGame
    }
    changeGame()
})




const createModal = (type, message) => {
    return new Promise(resolve => {
        const displayMessage = message.prompt ? message.prompt : message
        const modal = createElem("div.modal#activeModal", {style: {opacity: 0}}, createElem("span", displayMessage))
        modal.dataset.type = type

        if (type=="confirm") {
            const yesButton = createElem("button", {style: {background: `#${themeColour}`}})
            yesButton.innerHTML = "Yes"
            const noButton = createElem("button", {style: {background: `#${themeColour}`}})
            noButton.innerHTML = "No"
            modal.appendChild(createElem("div", yesButton, noButton))

            yesButton.addEventListener("click", () => {
                closeModal().then(() => {
                    resolve(true)
                })
            })
            noButton.addEventListener("click", () => {
                closeModal().then(() => {
                    resolve(false)
                })
            })
        } else if (type=="error") {
            const closeButton = createElem("button", {style: {background: `#${themeColour}`}})
            closeButton.innerHTML = "Close"
            modal.appendChild(createElem("div", closeButton))

            closeButton.addEventListener("click", () => {
                closeModal().then(() => {
                    resolve(false)
                })
            })
        } else if (type=="prompt") {
            const closeButton = createElem("button", {style: {background: `#${themeColour}`}})
            closeButton.innerHTML = "Submit"
            const inputElem = createElem("input", {type: "text", value: message.value})
            modal.appendChild(createElem("div", inputElem))
            modal.appendChild(createElem("div", closeButton))

            closeButton.addEventListener("click", () => {
                closeModal().then(() => {
                    resolve(inputElem.value)
                })
            })
        } else {
            modal.appendChild(createElem("div.spinner", {style: {borderLeftColor: document.querySelector("button").style.background}}))
        }

        modalContainer.appendChild(modal)
        modalContainer.style.opacity = 0
        modalContainer.style.display = "flex"

        requestAnimationFrame(() => requestAnimationFrame(() => modalContainer.style.opacity = 1))
        requestAnimationFrame(() => requestAnimationFrame(() => chrome.style.opacity = 1))
    })
}
window.closeModal = (container=modalContainer) => {
    return new Promise(resolve => {
        container.style.opacity = 0
        chrome.style.opacity = 0.88
        setTimeout(() => {
            container.style.display = "none"
            try {
                activeModal.remove()
            } catch (e) {}
            resolve()
        }, 300)
    })
}

window.confirmModal = message => new Promise(resolve => resolve(createModal("confirm", message)))
window.spinnerModal = message => new Promise(resolve => resolve(createModal("spinner", message)))
window.errorModal = message => new Promise(resolve => resolve(createModal("error", message)))


modalContainer.addEventListener("click", event => {
    if (event.target==modalContainer && activeModal.dataset.type!="spinner") {
        closeModal()
    }
})

dialogueInput.addEventListener("keyup", () => {
    localStorage.setItem("dialogueInput", dialogueInput.value)
    window.pitchEditor.hasChanged = true
})

const dialogueInputCache = localStorage.getItem("dialogueInput")

if (dialogueInputCache) {
    dialogueInput.value = dialogueInputCache
}

window.addEventListener("resize", e => {
    window.userSettings.customWindowSize = `${window.innerHeight},${window.innerWidth}`
    saveUserSettings()
})




const setPitchEditorValues = (letters, pitchOrig, lengthsOrig, isFreshRegen) => {

    editor.innerHTML = ""

    if (isFreshRegen || window.pitchEditor.lengthsMult.length==0) {
        window.pitchEditor.lengthsMult = lengthsOrig.map(l => 1)
        window.pitchEditor.letterFocus = -1
    }
    let pacingMult = lengthsOrig.map(l => 1)

    window.pitchEditor.pitchNew = pitchOrig.map(p=>p)
    window.pitchEditor.dursNew = lengthsOrig.map(v=>v)


    const letterElems = []
    const css_hack_items = []
    const elemsWidths = []
    let autoinfer_timer = null
    let has_been_changed = false

    const set_letter_display = (elem, elem_i, length=null, value=null) => {

        if (length != null && elem) {
            const elem_length = length/2
            elem.style.width = `${parseInt(elem_length/2)}px`
            elem.children[1].style.height = `${elem_length}px`
            elem.children[1].style.marginTop = `${-parseInt(elem_length/2)+65}px`
            css_hack_items[elem_i].innerHTML = `#slider_${elem_i}::-webkit-slider-thumb {height: ${elem_length}px;}`
            elemsWidths[elem_i] = elem_length
            elem.style.paddingLeft = `${parseInt(elem_length/2)}px`
            editor.style.width = `${parseInt(elemsWidths.reduce((p,c)=>p+c,1)*1.25)}px`
        }

        if (value != null) {
            elem.children[1].value = value
        }
    }


    letters.forEach((letter, l) => {

        const letterDiv = createElem("div.letter", createElem("div", letter))
        const slider = createElem(`input.slider#slider_${l}`, {
            type: "range",
            orient: "vertical",
            step: 0.001,
            min: -3,
            max:  3,
            value: pitchOrig[l]
        })
        letterDiv.appendChild(slider)

        slider.addEventListener("mousedown", () => {
            if (window.pitchEditor.letterFocus>0) {
                letterElems[window.pitchEditor.letterFocus].style.color = "black"
            }
            window.pitchEditor.letterFocus = l
            letterElems[l].style.color = "red"
            letterLength.value = parseInt(window.pitchEditor.lengthsMult[window.pitchEditor.letterFocus])
        })
        if (window.pitchEditor.letterFocus == l) {
            letterDiv.style.color = "red"
        }

        slider.addEventListener("change", () => {
            window.pitchEditor.pitchNew[l] = parseFloat(slider.value)
            has_been_changed = true
            if (autoplay_ckbx.checked) {
                generateVoiceButton.click()
            }
        })


        let length = window.pitchEditor.resetDurs[l] * window.pitchEditor.lengthsMult[l] * pace_slid.value * 10 + 50

        letterDiv.style.width = `${parseInt(length/2)}px`
        slider.style.height = `${length}px`

        slider.style.marginLeft = `${-83}px`
        letterDiv.style.paddingLeft = `${parseInt(length/2)}px`

        const css_hack_elem = createElem("style", `#slider_${l}::-webkit-slider-thumb {height: ${length}px;}`)
        css_hack_items.push(css_hack_elem)
        css_hack_pitch_editor.appendChild(css_hack_elem)
        elemsWidths.push(length)
        editor.style.width = `${parseInt(elemsWidths.reduce((p,c)=>p+c,1)*1.15)}px`

        editor.appendChild(letterDiv)
        letterElems.push(letterDiv)

        set_letter_display(letterDiv, l, length, pitchOrig[l])
    })


    const infer = () => {
        movingSlider = false
        has_been_changed = false
        if (!isGenerating) {
            generateVoiceButton.click()
        }
    }


    let movingSlider = false
    letterLength.addEventListener("mousedown", () => movingSlider=true)
    letterLength.addEventListener("mouseup", () => movingSlider=false)
    letterLength.addEventListener("change", () => movingSlider=false)


    resetLetter_btn.addEventListener("click", () => {
        if (window.pitchEditor.letterFocus<0) {
            return
        }
        if (window.pitchEditor.lengthsMult[window.pitchEditor.letterFocus] != letterLength.value) {
            has_been_changed = true
        }
        window.pitchEditor.dursNew[window.pitchEditor.letterFocus] = window.pitchEditor.resetDurs[window.pitchEditor.letterFocus]
        window.pitchEditor.pitchNew[window.pitchEditor.letterFocus] = window.pitchEditor.resetPitch[window.pitchEditor.letterFocus]
        set_letter_display(letterElems[window.pitchEditor.letterFocus], window.pitchEditor.letterFocus, window.pitchEditor.resetDurs[window.pitchEditor.letterFocus]*10+50, window.pitchEditor.pitchNew[window.pitchEditor.letterFocus])
    })
    letterLength.addEventListener("mousemove", () => {
        if (window.pitchEditor.letterFocus<0 || !movingSlider) {
            return
        }

        if (window.pitchEditor.lengthsMult[window.pitchEditor.letterFocus] != letterLength.value) {
            has_been_changed = true
        }
        window.pitchEditor.lengthsMult[window.pitchEditor.letterFocus] = parseFloat(letterLength.value)
        window.pitchEditor.lengthsMult.forEach((v,vi) => window.pitchEditor.dursNew[vi] = window.pitchEditor.resetDurs[vi] * v * pace_slid.value)

        const letterElem = letterElems[window.pitchEditor.letterFocus]
        const newWidth = window.pitchEditor.resetDurs[window.pitchEditor.letterFocus] * window.pitchEditor.lengthsMult[window.pitchEditor.letterFocus] * pace_slid.value //* 100
        set_letter_display(letterElem, window.pitchEditor.letterFocus, newWidth * 10 + 50)
    })
    letterLength.addEventListener("mouseup", () => {
        if (has_been_changed) {
            if (autoinfer_timer != null) {
                clearTimeout(autoinfer_timer)
                autoinfer_timer = null
            }
            if (autoplay_ckbx.checked) {
                autoinfer_timer = setTimeout(infer, 500)
            }
        }
    })

    // Reset button
    reset_btn.addEventListener("click", () => {
        window.pitchEditor.lengthsMult = lengthsOrig.map(l => 1)
        window.pitchEditor.dursNew = window.pitchEditor.resetDurs
        window.pitchEditor.pitchNew = window.pitchEditor.resetPitch.map(p=>p)
        letters.forEach((_, l) => set_letter_display(letterElems[l], l, window.pitchEditor.resetDurs[l]*10+50, window.pitchEditor.pitchNew[l]))
    })
    amplify_btn.addEventListener("click", () => {
        window.pitchEditor.ampFlatCounter += 1
        window.pitchEditor.pitchNew = window.pitchEditor.resetPitch.map(p=> {
            const newVal = p*(1+window.pitchEditor.ampFlatCounter*0.025)
            return newVal>0 ? Math.min(3, newVal) : Math.max(-3, newVal)
        })
        letters.forEach((_, l) => set_letter_display(letterElems[l], l, null, window.pitchEditor.pitchNew[l]))
    })
    flatten_btn.addEventListener("click", () => {
        window.pitchEditor.ampFlatCounter -= 1
        window.pitchEditor.pitchNew = window.pitchEditor.resetPitch.map(p=>p*Math.max(0, 1+window.pitchEditor.ampFlatCounter*0.025))
        letters.forEach((_, l) => set_letter_display(letterElems[l], l, null, window.pitchEditor.pitchNew[l]))
    })
    increase_btn.addEventListener("click", () => {
        window.pitchEditor.pitchNew = window.pitchEditor.pitchNew.map(p=>p+=0.1)
        letters.forEach((_, l) => set_letter_display(letterElems[l], l, null, window.pitchEditor.pitchNew[l]))
    })
    decrease_btn.addEventListener("click", () => {
        window.pitchEditor.pitchNew = window.pitchEditor.pitchNew.map(p=>p-=0.1)
        letters.forEach((_, l) => set_letter_display(letterElems[l], l, null, window.pitchEditor.pitchNew[l]))
    })
    pace_slid.addEventListener("change", () => {
        const new_lengths = window.pitchEditor.resetDurs.map((v,l) => v * window.pitchEditor.lengthsMult[l] * pace_slid.value)
        window.pitchEditor.dursNew = new_lengths
        letters.forEach((_, l) => set_letter_display(letterElems[l], l, new_lengths[l]* 10 + 50, null))
    })
}
autoplay_ckbx.addEventListener("change", () => {
    window.userSettings.autoplay = autoplay_ckbx.checked
    saveUserSettings()
})
qnd_ckbx.checked = window.userSettings.quick_n_dirty
qnd_ckbx.addEventListener("change", () => {
    window.userSettings.quick_n_dirty = qnd_ckbx.checked
    spinnerModal("Changing models...")
    fetch(`http://localhost:8008/setMode`, {
        method: "Post",
        body: JSON.stringify({hifi_gan: window.userSettings.quick_n_dirty ? "qnd" : "wg"})
    }).then(() => {
        closeModal().then(() => {
            saveUserSettings()
        })
    })
})

// Patreon
// =======
patreonIcon.addEventListener("click", () => {

    const data = fs.readFileSync("patreon.txt", "utf8")
    const names = new Set()
    data.split("\r\n").forEach(name => names.add(name))
    names.add("minermanb")

    let content = `You can support development on patreon at this link:<br>
        <span id="patreonLink" style='color:#${themeColour};text-decoration: underline;cursor:pointer;'>PATREON</span>
        <br><hr><br>Special thanks:`
    names.forEach(name => content += `<br>${name}`)

    createModal("error", content)
    patreonLink.addEventListener("click", () => {
        shell.openExternal("https://patreon.com")
    })
})
fetch("http://danruta.co.uk/patreon.txt").then(r=>r.text()).then(data => fs.writeFileSync("patreon.txt", data, "utf8"))


// Updates
// =======
app_version.innerHTML = window.appVersion
updatesVersions.innerHTML = `This app version: ${window.appVersion}`

const checkForUpdates = () => {
    fetch("http://danruta.co.uk/xvasynth_updates.txt").then(r=>r.json()).then(data => {
        fs.writeFileSync("updates.json", JSON.stringify(data), "utf8")
        checkUpdates.innerHTML = "Check for updates now"
        showUpdates()
    }).catch(() => {
        checkUpdates.innerHTML = "Can't reach server"
    })
}
const showUpdates = () => {
    window.updatesLog = fs.readFileSync("updates.json", "utf8")
    window.updatesLog = JSON.parse(window.updatesLog)
    const sortedLogVersions = Object.keys(window.updatesLog).map( a => a.split('.').map( n => +n+100000 ).join('.') ).sort()
        .map( a => a.split('.').map( n => +n-100000 ).join('.') )

    const appVersion = window.appVersion.replace("v", "")
    const appIsUpToDate = sortedLogVersions.indexOf(appVersion)==(sortedLogVersions.length-1) || sortedLogVersions.indexOf(appVersion)==-1

    if (!appIsUpToDate) {
        update_nothing.style.display = "none"
        update_something.style.display = "block"
        updatesVersions.innerHTML = `This app version: ${appVersion}. Available: ${sortedLogVersions[sortedLogVersions.length-1]}`
        console.log(`Update available: This: ${appVersion}, available: ${sortedLogVersions[sortedLogVersions.length-1]}`)
    } else {
        updatesVersions.innerHTML = `This app version: ${appVersion}. Up-to-date.`
        console.log("App is up-to-date")
    }

    updatesLogList.innerHTML = ""
    sortedLogVersions.forEach(version => {
        const versionLabel = createElem("div", version)
        const versionText = createElem("div", window.updatesLog[version])
        updatesLogList.appendChild(createElem("div", versionLabel, versionText))
    })
}
checkForUpdates()
updatesIcon.addEventListener("click", () => {
    updatesContainer.style.opacity = 0
    updatesContainer.style.display = "flex"
    chrome.style.opacity = 0.88
    requestAnimationFrame(() => requestAnimationFrame(() => updatesContainer.style.opacity = 1))
    requestAnimationFrame(() => requestAnimationFrame(() => chrome.style.opacity = 1))
})
updatesContainer.addEventListener("click", event => {
    if (event.target==updatesContainer) {
        closeModal(updatesContainer)
    }
})
checkUpdates.addEventListener("click", () => {
    checkUpdates.innerHTML = "Checking for updates..."
    checkForUpdates()
})
showUpdates()