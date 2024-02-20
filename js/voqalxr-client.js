// VoqalXR Client
export class XRTextContent {
    constructor(content) {
        this.content = content;
    }
}
export class XRImageContent {
    constructor(image) {
        this.content = image;
    }
    getImage() {
        return this.content;
    }
}
export class XRWindow {
    constructor(id, content) {
        this.disposed = false;
        this.visible = true;
        this.selected = false;
        // @ts-ignore
        this.userData = new Map();
        this.listeners = [];
        this.id = id;
        this.content = content;
    }
    getId() {
        return this.id;
    }
    isEditor() {
        return this instanceof Editor;
    }
    isToolWindow() {
        return this instanceof ToolWindow;
    }
    getContent() {
        return this.content;
    }
    isVisible() {
        return this.visible;
    }
    isSelected() {
        return this.selected;
    }
    isDisposed() {
        return this.disposed;
    }
    setUserData(key, value) {
        this.userData.set(key, value);
    }
    getUserData(key) {
        return this.userData.get(key);
    }
    addListener(listener) {
        if (this.disposed) {
            throw new Error('Editor is disposed');
        }
        this.listeners.push(listener);
    }
    setContent(content) {
        if (this.disposed) {
            throw new Error('Editor is disposed');
        }
        this.content = content;
        this.notifyListeners("content");
    }
    dispose() {
        if (this.disposed) {
            throw new Error('Editor is disposed');
        }
        this.disposed = true;
        this.notifyListeners("disposed");
    }
    setVisible(visible) {
        if (this.disposed) {
            throw new Error('Editor is disposed');
        }
        else if (this.visible === visible) {
            return; //no change
        }
        this.visible = visible;
        this.notifyListeners("visible");
    }
    setSelected(selected) {
        if (this.disposed) {
            throw new Error('Editor is disposed');
        }
        else if (this.selected === selected) {
            return; //no change
        }
        this.selected = selected;
        this.notifyListeners("selected");
    }
    notifyListeners(type) {
        this.listeners.forEach(listener => listener(this, type));
    }
}
export class Editor extends XRWindow {
    constructor(id, filename, content) {
        super(id, content);
        this.status = "WAITING";
        this.statusMessage = "";
        this.filename = filename;
    }
    getFilename() {
        return this.filename;
    }
    setStatus(status, message) {
        if (this.disposed) {
            throw new Error('Editor is disposed');
        }
        this.status = status;
        this.statusMessage = message;
        this.notifyListeners("status");
    }
    getStatus() {
        return this.status;
    }
    getStatusMessage() {
        return this.statusMessage;
    }
}
export class ToolWindow extends XRWindow {
    constructor(id, title, content) {
        super(id, content);
        this.title = title;
    }
    getTitle() {
        return this.title;
    }
}
export class VoqalXRClient {
    constructor(config) {
        this.localStream = [];
        // @ts-ignore
        this.receivedChunkMap = new Map();
        // @ts-ignore
        this.editors = new Map();
        // @ts-ignore
        this.toolWindows = new Map();
        this.sessionId = "";
        this.listeners = [];
        this.config = Object.assign({ webSocketURL: config.webSocketURL || 'wss://signal.voqal.dev', transmitAudio: config.transmitAudio || true }, config);
        this.pc = new RTCPeerConnection();
        this.ws = new WebSocket(this.config.webSocketURL);
        if (config.transmitAudio) {
            console.log("Getting media devices");
            navigator.mediaDevices
                .getUserMedia({ video: false, audio: true })
                .then((stream) => {
                    console.log("Found user media");
                    this.localStream.push(stream);
                    this.setupWebSocket();
                    this.setupPeerConnection();
                })
                .catch((err) => {
                    console.error(`Failed to get user media: ${err}`);
                });
        }
        else {
            console.log("Not getting media devices");
            this.setupWebSocket();
            this.setupPeerConnection();
        }
    }
    connect(sessionToConnect) {
        console.log('Connecting to session: ' + sessionToConnect);
        this.ws.send(JSON.stringify({
            message: "connect",
            sessionid: sessionToConnect
        }));
    }
    setupWebSocket() {
        this.ws.onopen = () => {
            console.log('WebSocket connection opened');
        };
        this.ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            switch (message.message) {
                case 'greeting':
                    this.handleGreeting(message);
                    break;
                case 'offer':
                    this.handleOffer(message.sdp, message.mySessionId, message.targetSessionId);
                    break;
                case 'answer':
                    this.handleAnswer(message.sdp);
                    break;
                case 'icecandidate':
                    this.handleIceCandidate(message.candidate);
                    break;
                default:
                    throw new Error('Unknown signal message: ' + message.message);
            }
        };
    }
    handleGreeting(message) {
        this.sessionId = message.sessionid;
        console.log('Got session id: ' + this.sessionId);
        this.setupDataChannel();
        if (this.config.transmitAudio) {
            //wait to local stream to be ready
            let intervalID = setInterval(() => {
                if (this.localStream.length > 0) {
                    console.log('Got local audio stream');
                    let ac = new AudioContext();
                    let source = ac.createMediaStreamSource(this.localStream[0]);
                    let destination = ac.createMediaStreamDestination();
                    source.connect(destination);
                    let stream = destination.stream;
                    const audioTrack = stream.getAudioTracks()[0];
                    this.pc.addTrack(audioTrack, stream);
                    this.negotiate();
                    //stop interval
                    clearInterval(intervalID);
                }
                else {
                    console.log('Waiting for local audio stream');
                }
            }, 1000);
        }
        else {
            this.negotiate();
        }
    }
    handleFile(data) {
        console.log('File chunk received: ', data.number + ' of ' + data.total);
        let receivedChunks = this.receivedChunkMap.get(data.id);
        if (receivedChunks == null) {
            receivedChunks = [];
            this.receivedChunkMap.set(data.id, receivedChunks);
        }
        receivedChunks[data.number] = data.chunk;
        if (data.number === data.total - 1) {
            let base64 = receivedChunks.join('');
            this.receivedChunkMap.delete(data.id);
            let binary = atob(base64);
            let audioFile = new Blob([new Uint8Array(binary.length).map((_, i) => binary.charCodeAt(i))], { type: 'audio/mp3' });
            this.playAudioFile(audioFile);
        }
    }
    playAudioFile(file) {
        let url = URL.createObjectURL(file);
        let audio = new Audio(url);
        audio.play();
    }
    removeEditor(index) {
        console.log("Removing editor: ", index);
        let editor = this.editors.get(index);
        if (editor) {
            editor.dispose();
            this.editors.delete(index);
        }
        else {
            console.error("Editor not found: ", index);
        }
    }
    addImageEditor(message) {
        let index = message.number;
        let name = message.name;
        let content = message.chunk;
        if (this.editors.has(index)) {
            //console.log("Updating editor (image): ", index)
            let image = new Image();
            image.onload = () => {
                let editor = this.editors.get(index);
                editor.setContent(new XRImageContent(image));
            };
            image.src = "data:image/png;base64," + content;
        }
        else {
            let image = new Image();
            image.onload = () => {
                let imageContent = new XRImageContent(image);
                let editor = new Editor(index, name, imageContent);
                let imageSize = imageContent.getImage().width + "x" + imageContent.getImage().height;
                console.log("Adding editor (image): " + index + " - Size: " + imageSize);
                this.editors.set(index, editor);
                this.notifyListeners("add_editor", editor);
            };
            image.src = "data:image/png;base64," + content;
        }
    }
    addImageToolWindow(message) {
        let index = message.number;
        let name = message.name;
        let content = message.chunk;
        if (this.toolWindows.has(index)) {
            //console.log("Updating tool window (image): ", index)
            let image = new Image();
            image.onload = () => {
                let toolWindow = this.toolWindows.get(index);
                toolWindow.setContent(new XRImageContent(image));
            };
            image.src = "data:image/png;base64," + content;
        }
        else {
            let image = new Image();
            image.onload = () => {
                let imageContent = new XRImageContent(image);
                let toolWindow = new ToolWindow(index, name, imageContent);
                let imageSize = imageContent.getImage().width + "x" + imageContent.getImage().height;
                console.log("Adding tool window (image): " + index + " - Size: " + imageSize);
                this.toolWindows.set(index, toolWindow);
                this.notifyListeners("add_tool_window", toolWindow);
            };
            image.src = "data:image/png;base64," + content;
        }
    }
    removeToolWindow(index) {
        console.log("Removing tool window: ", index);
        let toolWindow = this.toolWindows.get(index);
        if (toolWindow) {
            toolWindow.dispose();
            this.toolWindows.delete(index);
        }
        else {
            console.error("Tool window not found: ", index);
        }
    }
    notifyListeners(type, xrWindow) {
        this.listeners.forEach(listener => listener(type, xrWindow));
    }
    addIDEChangeListener(listener) {
        this.listeners.push(listener);
    }
    setEditorStatus(index, status, message) {
        let editor = this.editors.get(index);
        if (editor) {
            editor.setStatus(status, message);
        }
        else {
            console.error("Editor not found: ", index);
        }
    }
    doSelectEditor(index) {
        console.log("Setting selected editor: ", index);
        this.editors.forEach((editor, key) => {
            editor.setSelected(key === index);
        });
    }
    setSelectedEditor(index) {
        var _a;
        if ((_a = this.editors.get(index)) === null || _a === void 0 ? void 0 : _a.isSelected()) {
            return; //already selected
        }
        this.doSelectEditor(index);
        const json = {
            "number": index,
            "type": "selected_editor"
        };
        this.sendMessage(json);
    }
    hideIde() {
        console.log("Hiding IDE");
        this.editors.forEach((editor, index) => {
            editor.setVisible(false);
        });
        this.notifyListeners("hide_ide");
    }
    showIde() {
        console.log("Showing IDE");
        this.editors.forEach((editor, index) => {
            editor.setVisible(true);
        });
        this.notifyListeners("show_ide");
    }
    negotiate() {
        this.pc.createOffer()
            .then(offer => {
                this.pc.setLocalDescription(offer);
                this.ws.send(JSON.stringify({
                    message: "offer",
                    sdp: offer
                }));
            });
    }
    setupPeerConnection() {
        this.pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.ws.send(JSON.stringify({
                    message: "icecandidate",
                    candidate: event.candidate
                }));
            }
        };
    }
    setupDataChannel() {
        this.dc = this.pc.createDataChannel('myDataChannel');
        this.dc.binaryType = 'arraybuffer';
        this.dc.onmessage = (event) => {
            const message = JSON.parse(event.data);
            //console.log('Data channel message received: ', message.type);
            switch (message.type) {
                case 'hide_ide':
                    this.hideIde();
                    break;
                case 'show_ide':
                    this.showIde();
                    break;
                case 'remove_editor':
                    this.removeEditor(message.number);
                    break;
                case 'add_editor':
                    this.addImageEditor(message);
                    break;
                case 'set_selected_editor':
                    this.doSelectEditor(message.number);
                    break;
                case 'set_editor_status':
                    this.setEditorStatus(message.number, message.status, message.message);
                    break;
                case 'file':
                    this.handleFile(message);
                    break;
                case 'add_tool_window':
                    this.addImageToolWindow(message);
                    break;
                case 'remove_tool_window':
                    this.removeToolWindow(message.number);
                    break;
                default:
                    throw new Error('Unknown peer message: ' + message.type);
            }
            if (this.config.onDataChannelMessage) {
                this.config.onDataChannelMessage(message);
            }
        };
        this.dc.onopen = () => console.log('Data channel opened');
        this.dc.onclose = () => console.log('Data channel closed');
    }
    handleOffer(sdp, mySessionId, targetSessionId) {
        const offerOptions = {
            offerToReceiveAudio: true,
            offerToReceiveVideo: true,
        };
        this.pc.setRemoteDescription(new RTCSessionDescription(sdp))
            .then(() => this.pc.createAnswer(offerOptions))
            .then(answer => {
                this.pc.setLocalDescription(answer);
                return answer;
            })
            .then(answer => {
                this.ws.send(JSON.stringify({
                    message: "answer",
                    mySessionId: mySessionId,
                    targetSessionId: targetSessionId,
                    sdp: answer
                }));
            });
    }
    handleAnswer(sdp) {
        this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    }
    handleIceCandidate(candidate) {
        this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
    sendMessage(message) {
        if (this.dc && this.dc.readyState === "open") {
            this.dc.send(JSON.stringify(message));
        }
        else {
            throw new Error('Data channel not open');
        }
    }
    close() {
        this.ws.close();
        this.pc.close();
    }
    getSessionId() {
        return this.sessionId;
    }
}
