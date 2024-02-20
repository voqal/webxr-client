// VoqalXR Client

export interface VoqalXRConfig {
    webSocketURL?: string;
    onDataChannelMessage?: (data: any) => void;
    transmitAudio?: boolean
}

export interface XRTextToken {
    fontSize: number;
    content: string;
    fontColor: string;
}

export interface XRContent {
    content: any;
}

export class XRTextContent implements XRContent {
    content: Array<XRTextToken>;

    constructor(content: Array<XRTextToken>) {
        this.content = content;
    }
}

export class XRImageContent implements XRContent {
    content: HTMLImageElement;

    constructor(image: HTMLImageElement) {
        this.content = image;
    }

    getImage(): HTMLImageElement {
        return this.content;
    }
}

type XRWindowChangeType = "status" | "content" | "visible" | "selected" | "disposed";
type XRWindowChangeListener = (window: XRWindow, type: XRWindowChangeType) => void;

type IDEChangeType =
    "add_tool_window"
    | "remove_tool_window"
    | "add_editor"
    | "remove_editor"
    | "hide_ide"
    | "show_ide"
    | "selected_editor"
    | "file";
type IDEChangeListener = (type: IDEChangeType, window?: XRWindow) => void;

export class XRWindow {
    protected id: number;
    protected disposed: boolean = false;
    protected visible: boolean = true;
    protected selected: boolean = false;
    protected content: XRContent;
    // @ts-ignore
    protected userData: Map<string, any> = new Map();
    private listeners: XRWindowChangeListener[] = [];

    constructor(id: number, content: XRContent) {
        this.id = id;
        this.content = content;
    }

    getId(): number {
        return this.id;
    }

    isEditor(): boolean {
        return this instanceof Editor;
    }

    isToolWindow(): boolean {
        return this instanceof ToolWindow;
    }

    getContent(): XRContent {
        return this.content;
    }

    isVisible(): boolean {
        return this.visible;
    }

    isSelected(): boolean {
        return this.selected;
    }

    isDisposed(): boolean {
        return this.disposed;
    }

    setUserData(key: string, value: any) {
        this.userData.set(key, value);
    }

    getUserData(key: string): any {
        return this.userData.get(key);
    }

    addListener(listener: XRWindowChangeListener) {
        if (this.disposed) {
            throw new Error('Editor is disposed');
        }
        this.listeners.push(listener);
    }

    setContent(content: XRContent) {
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

    setVisible(visible: boolean) {
        if (this.disposed) {
            throw new Error('Editor is disposed');
        } else if (this.visible === visible) {
            return; //no change
        }
        this.visible = visible;
        this.notifyListeners("visible");
    }

    setSelected(selected: boolean) {
        if (this.disposed) {
            throw new Error('Editor is disposed');
        } else if (this.selected === selected) {
            return; //no change
        }
        this.selected = selected;
        this.notifyListeners("selected");
    }

    protected notifyListeners(type: XRWindowChangeType) {
        this.listeners.forEach(listener => listener(this, type));
    }
}

export class Editor extends XRWindow {
    private readonly filename: string;
    private status: string = "WAITING";
    private statusMessage: string = "";

    constructor(id: number, filename: string, content: XRContent) {
        super(id, content);
        this.filename = filename;
    }

    getFilename(): string {
        return this.filename;
    }

    setStatus(status: string, message: string) {
        if (this.disposed) {
            throw new Error('Editor is disposed');
        }
        this.status = status;
        this.statusMessage = message;
        this.notifyListeners("status");
    }

    getStatus(): string {
        return this.status;
    }

    getStatusMessage(): string {
        return this.statusMessage;
    }
}

export class ToolWindow extends XRWindow {
    private readonly title: string;

    constructor(id: number, title: string, content: XRContent) {
        super(id, content);
        this.title = title;
    }

    getTitle(): string {
        return this.title;
    }
}

export class VoqalXRClient {
    private ws: WebSocket;
    private pc: RTCPeerConnection;
    private config: VoqalXRConfig;
    private dc?: RTCDataChannel;
    private localStream: MediaStream[] = []
    // @ts-ignore
    private receivedChunkMap = new Map<number, any[]>();
    // @ts-ignore
    private editors: Map<number, Editor> = new Map();
    // @ts-ignore
    private toolWindows: Map<number, ToolWindow> = new Map();
    private sessionId: string = "";
    private listeners: IDEChangeListener[] = [];

    constructor(config: VoqalXRConfig) {
        this.config = {
            webSocketURL: config.webSocketURL || 'wss://signal.voqal.dev',
            transmitAudio: config.transmitAudio || true,
            ...config
        };
        this.pc = new RTCPeerConnection();
        this.ws = new WebSocket(this.config.webSocketURL!!);

        if (config.transmitAudio) {
            console.log("Getting media devices")
            navigator.mediaDevices
                .getUserMedia({video: false, audio: true})
                .then((stream) => {
                    console.log("Found user media")
                    this.localStream.push(stream)
                    this.setupWebSocket();
                    this.setupPeerConnection();
                })
                .catch((err) => {
                    console.error(`Failed to get user media: ${err}`);
                })
        } else {
            console.log("Not getting media devices")
            this.setupWebSocket();
            this.setupPeerConnection();
        }
    }

    connect(sessionToConnect: string) {
        console.log('Connecting to session: ' + sessionToConnect);
        this.ws.send(JSON.stringify({
            message: "connect",
            sessionId: sessionToConnect
        }));
    }

    private setupWebSocket() {
        this.ws.onopen = () => {
            console.log('WebSocket connection opened');
        };

        this.ws.onmessage = (event: MessageEvent) => {
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

    private handleGreeting(message: any) {
        this.sessionId = message.sessionId;
        console.log('Got session id: ' + this.sessionId)

        this.setupDataChannel();
        if (this.config.transmitAudio) {
            //wait to local stream to be ready
            let intervalID = setInterval(() => {
                if (this.localStream.length > 0) {
                    console.log('Got local audio stream')
                    let ac = new AudioContext()
                    let source = ac.createMediaStreamSource(this.localStream[0])
                    let destination = ac.createMediaStreamDestination()
                    source.connect(destination)
                    let stream = destination.stream
                    const audioTrack = stream.getAudioTracks()[0]
                    this.pc.addTrack(audioTrack, stream)

                    this.negotiate()

                    //stop interval
                    clearInterval(intervalID)
                } else {
                    console.log('Waiting for local audio stream')
                }
            }, 1000);
        } else {
            this.negotiate()
        }
    }

    private handleFile(data: any) {
        console.log('File chunk received: ', data.number + ' of ' + data.total)
        let receivedChunks = this.receivedChunkMap.get(data.id)
        if (receivedChunks == null) {
            receivedChunks = []
            this.receivedChunkMap.set(data.id, receivedChunks)
        }
        receivedChunks[data.number] = data.chunk

        if (data.number === data.total - 1) {
            let base64 = receivedChunks.join('')
            this.receivedChunkMap.delete(data.id)

            let binary = atob(base64)
            let audioFile = new Blob(
                [new Uint8Array(binary.length).map((_, i) => binary.charCodeAt(i))],
                {type: 'audio/mp3'},
            )
            this.playAudioFile(audioFile)
        }
    }

    private playAudioFile(file: any) {
        let url = URL.createObjectURL(file)
        let audio = new Audio(url)
        audio.play()
    }

    private removeEditor(index: number) {
        console.log("Removing editor: ", index)
        let editor = this.editors.get(index)
        if (editor) {
            editor.dispose();
            this.editors.delete(index);
        } else {
            console.error("Editor not found: ", index)
        }
    }

    private addImageEditor(message: any) {
        let index = message.number
        let name = message.name
        let content = message.chunk
        if (this.editors.has(index)) {
            //console.log("Updating editor (image): ", index)
            let image = new Image();
            image.onload = () => {
                let editor = this.editors.get(index)!!;
                editor.setContent(new XRImageContent(image));
            }
            image.src = "data:image/png;base64," + content;
        } else {
            let image = new Image();
            image.onload = () => {
                let imageContent = new XRImageContent(image);
                let editor = new Editor(index, name, imageContent);
                let imageSize = imageContent.getImage().width + "x" + imageContent.getImage().height
                console.log("Adding editor (image): " + index + " - Size: " + imageSize);
                this.editors.set(index, editor);
                this.notifyListeners("add_editor", editor);
            }
            image.src = "data:image/png;base64," + content;
        }
    }

    private addImageToolWindow(message: any) {
        let index = message.number
        let name = message.name
        let content = message.chunk
        if (this.toolWindows.has(index)) {
            //console.log("Updating tool window (image): ", index)
            let image = new Image();
            image.onload = () => {
                let toolWindow = this.toolWindows.get(index)!!;
                toolWindow.setContent(new XRImageContent(image));
            }
            image.src = "data:image/png;base64," + content;
        } else {
            let image = new Image();
            image.onload = () => {
                let imageContent = new XRImageContent(image);
                let toolWindow = new ToolWindow(index, name, imageContent);
                let imageSize = imageContent.getImage().width + "x" + imageContent.getImage().height
                console.log("Adding tool window (image): " + index + " - Size: " + imageSize);
                this.toolWindows.set(index, toolWindow);
                this.notifyListeners("add_tool_window", toolWindow);
            }
            image.src = "data:image/png;base64," + content;
        }
    }

    private removeToolWindow(index: number) {
        console.log("Removing tool window: ", index)
        let toolWindow = this.toolWindows.get(index)
        if (toolWindow) {
            toolWindow.dispose();
            this.toolWindows.delete(index);
        } else {
            console.error("Tool window not found: ", index)
        }
    }

    private notifyListeners(type: IDEChangeType, xrWindow?: XRWindow) {
        this.listeners.forEach(listener => listener(type, xrWindow));
    }

    addIDEChangeListener(listener: IDEChangeListener) {
        this.listeners.push(listener);
    }

    private setEditorStatus(index: number, status: string, message: string) {
        let editor = this.editors.get(index)
        if (editor) {
            editor.setStatus(status, message)
        } else {
            console.error("Editor not found: ", index)
        }
    }

    private doSelectEditor(index: number) {
        console.log("Setting selected editor: ", index)
        this.editors.forEach((editor, key) => {
            editor.setSelected(key === index);
        });
    }

    setSelectedEditor(index: number) {
        if (this.editors.get(index)?.isSelected()) {
            return //already selected
        }
        this.doSelectEditor(index)

        const json = {
            "number": index,
            "type": "selected_editor"
        }
        this.sendMessage(json)
    }

    private hideIde() {
        console.log("Hiding IDE")
        this.editors.forEach((editor, index) => {
            editor.setVisible(false)
        });
        this.notifyListeners("hide_ide");
    }

    private showIde() {
        console.log("Showing IDE")
        this.editors.forEach((editor, index) => {
            editor.setVisible(true)
        });
        this.notifyListeners("show_ide");
    }

    private negotiate() {
        this.pc.createOffer()
            .then(offer => {
                this.pc.setLocalDescription(offer);
                this.ws.send(JSON.stringify({
                    message: "offer",
                    sdp: offer
                }));
            });
    }

    private setupPeerConnection() {
        this.pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
            if (event.candidate) {
                this.ws.send(JSON.stringify({
                    message: "icecandidate",
                    candidate: event.candidate
                }));
            }
        };
    }

    private setupDataChannel() {
        this.dc = this.pc.createDataChannel('myDataChannel');
        this.dc.binaryType = 'arraybuffer';

        this.dc.onmessage = (event: MessageEvent) => {
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

    private handleOffer(sdp: RTCSessionDescriptionInit, mySessionId: string, targetSessionId: string) {
        const offerOptions: RTCOfferOptions = {
            offerToReceiveAudio: true,
            offerToReceiveVideo: true,
        }
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

    private handleAnswer(sdp: RTCSessionDescriptionInit) {
        this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    }

    private handleIceCandidate(candidate: RTCIceCandidateInit) {
        this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }

    public sendMessage(message: any) {
        if (this.dc && this.dc.readyState === "open") {
            this.dc.send(JSON.stringify(message));
        } else {
            throw new Error('Data channel not open');
        }
    }

    public close() {
        this.ws.close();
        this.pc.close();
    }

    public getSessionId(): string {
        return this.sessionId;
    }
}
