import {WebXRButton} from 'util/webxr-button.js';
import {Scene, WebXRView} from 'render/scenes/scene.js';
import {createWebGLContext, Renderer} from 'render/core/renderer.js';
import {loadTextureFromImage} from 'util/texture-loader.js';
import {QuadNode} from 'render/nodes/quad-texture.js';
import {VoqalXRClient} from "voqalxr-client.js";
import {SkyboxNode} from "render/nodes/skybox.js";
import {quat} from "third-party/gl-matrix/src/gl-matrix.js";

export const xrClient = new VoqalXRClient({
    webSocketURL: "wss://signal.voqal.dev:443",
    transmitAudio: true,
});

window.connect = function () {
    let id = prompt("Please enter your id", (parseInt(xrClient.getSessionId()) - 1).toString());
    xrClient.connect(id);
}

window.autoConnect = function (id) {
    xrClient.connect(id ?? (parseInt(xrClient.getSessionId()) - 1).toString());
}

const QUAD_TRANSPARENT_MONO_PATH = 'images/transparent.png';

// XR globals.
let xrButton = null;
let xrSession = null;
let xrRefSpace = null;
let xrGLFactory = null;
let xrFramebuffer = null;
let stereoUtil = null;

// WebGL scene globals.
let gl = null;
let renderer = null;
let scene = new Scene();
scene.addNode(new SkyboxNode({
    url: 'images/skybox.jpg'
}));

// Layer globals
let projLayer = null;
let scale = 0.75;

function initXR() {
    xrButton = new WebXRButton({
        onRequestSession: onRequestSession,
        onEndSession: onEndSession
    });
    document.querySelector('body').appendChild(xrButton.domElement);

    if (navigator.xr) {
        navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
            xrButton.enabled = supported;
        });
    }
}

function onRequestSession() {
    if (!xrSession) {
        navigator.xr.requestSession('immersive-vr', {
            requiredFeatures: ['layers'],
        }).then(onSessionStarted);
    } else {
        onEndSession();
    }
}

function initGL() {
    if (gl) {
        return;
    }
    gl = createWebGLContext({xrCompatible: true, webgl2: true,});
    document.body.appendChild(gl.canvas);

    function onResize() {
        gl.canvas.width = gl.canvas.clientWidth * window.devicePixelRatio;
        gl.canvas.height = gl.canvas.clientHeight * window.devicePixelRatio;
    }

    window.addEventListener('resize', onResize);
    onResize();

    renderer = new Renderer(gl);
    scene.setRenderer(renderer);

    // Util for rendering stereo layers
    // eslint-disable-next-line no-undef
    stereoUtil = new VRStereoUtil(gl);
}

function onSessionStarted(session) {
    xrSession = session;
    scene.inputRenderer.useProfileControllerMeshes(session);
    session.addEventListener('end', onSessionEnded);

    initGL();

    xrFramebuffer = gl.createFramebuffer();
    // eslint-disable-next-line no-undef
    xrGLFactory = new XRWebGLBinding(session, gl);

    session.requestReferenceSpace('local').then((refSpace) => {
        xrRefSpace = refSpace;
        projLayer = xrGLFactory.createProjectionLayer({space: refSpace, stencil: false});
        session.updateRenderState({layers: [projLayer]});

        xrClient.addIDEChangeListener((changeType, xrWindow) => {
            if (changeType === "add_editor") {
                let {pos, orient} = getPosOrient(xrWindow.getId());
                createXRWindowLayer(xrWindow, gl, xrGLFactory, refSpace, scale, pos, orient);
            } else if (changeType === "add_tool_window") {
                let {pos, orient} = getPosOrient(xrWindow.getId());
                pos = {x: pos.x, y: pos.y + 1.3, z: pos.z};

                let tiltQuat = quat.create();
                quat.rotateX(tiltQuat, tiltQuat, Math.PI / 6); // 30 degrees in radians
                orient = [orient.x, orient.y, orient.z, orient.w];
                orient = quat.multiply(orient, orient, tiltQuat);
                orient = {x: orient[0], y: orient[1], z: orient[2], w: orient[3]};

                createXRWindowLayer(xrWindow, gl, xrGLFactory, refSpace, scale - 0.1, pos, orient);
            }
        });

        //todo: these handle initial state, should be refactored into listeners (force init to trigger listeners)
        xrClient.editors.forEach((editor, key) => {
            let {pos, orient} = getPosOrient(editor.getId());
            createXRWindowLayer(editor, gl, xrGLFactory, refSpace, scale, pos, orient);
        });
        xrClient.toolWindows.forEach((toolWindow, key) => {
            let {pos, orient} = getPosOrient(toolWindow.getId());
            pos = {x: pos.x, y: pos.y + 1.3, z: pos.z};

            let tiltQuat = quat.create();
            quat.rotateX(tiltQuat, tiltQuat, Math.PI / 6); // 30 degrees in radians
            orient = [orient.x, orient.y, orient.z, orient.w];
            orient = quat.multiply(orient, orient, tiltQuat);
            orient = {x: orient[0], y: orient[1], z: orient[2], w: orient[3]};

            createXRWindowLayer(toolWindow, gl, xrGLFactory, refSpace, scale - 0.1, pos, orient);
        });

        session.requestAnimationFrame(onXRFrame);
    });

    function isPowerOf2(value) {
        return (value & (value - 1)) == 0;
    }

    function createXRWindowLayer(xrWindow, gl, xrGLFactory, refSpace, scale, pos, orient) {
        console.log(
            "Creating layer for XRWindow: " + xrWindow.getId() + " - Editor: " + xrWindow.isEditor()
            + " - Position: " + JSON.stringify(pos) + " - Orientation: " + JSON.stringify(orient))
        ;
        xrWindow.addListener((_, type) => {
            if (type === "content") {
                let texture = xrWindow.getUserData("texture");
                const level = 0;
                const internalFormat = gl.RGBA;
                const srcFormat = gl.RGBA;
                const srcType = gl.UNSIGNED_BYTE;
                const image = xrWindow.content.getImage();
                gl.bindTexture(gl.TEXTURE_2D, texture);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
                gl.texImage2D(
                    gl.TEXTURE_2D,
                    level,
                    internalFormat,
                    srcFormat,
                    srcType,
                    image
                );

                // WebGL1 has different requirements for power of 2 images
                // vs non power of 2 images so check if the image is a
                // power of 2 in both dimensions.
                if (isPowerOf2(image.width) && isPowerOf2(image.height)) {
                    // Yes, it's a power of 2. Generate mips.
                    gl.generateMipmap(gl.TEXTURE_2D);
                    //?gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
                    //?gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR_MIPMAP_LINEAR);
                } else {
                    // No, it's not a power of 2. Turn of mips and set
                    // wrapping to clamp to edge
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                }
                xrWindow.setUserData("needsRedraw", true);
            } else if (type === "disposed" && xrWindow.isEditor()) {
                console.log("Editor disposed: " + xrWindow.getId());
                scene.removeNode(xrWindow.getUserData("collider"));
            }
        });

        loadTextureFromImage(gl, xrWindow.content.getImage(), (w, h, texture) => {
            let quadLayer = xrGLFactory.createQuadLayer({
                space: refSpace,
                viewPixelWidth: w,
                viewPixelHeight: h,
                layout: "mono"
            });
            quadLayer.width = w * scale / 1000;
            quadLayer.height = h * scale / 1000;
            // eslint-disable-next-line no-undef
            quadLayer.transform = new XRRigidTransform(pos, orient);

            // Make transparent placeholder node of the same size for quad layer
            // The placeholder node is in projection layer and thus can be used
            // for hit test
            let quadCollider = new QuadNode(QUAD_TRANSPARENT_MONO_PATH, 2, true);
            if (xrWindow.isEditor()) {
                quadCollider.name = "editor-" + xrWindow.getId();
            } else {
                quadCollider.name = "tool-window-" + xrWindow.getId();
            }
            quadCollider.translation = [pos.x, pos.y, pos.z];
            quadCollider.rotation = [orient.x, orient.y, orient.z, orient.w];
            quadCollider.scale = [quadLayer.width, quadLayer.height, 1];
            scene.addNode(quadCollider);
            xrWindow.setUserData("layer", quadLayer);
            xrWindow.setUserData("texture", texture);
            xrWindow.setUserData("collider", quadCollider);
            xrWindow.setUserData("needsRedraw", true);

            if (xrWindow.isEditor()) {
                addEditorStatus(xrWindow, gl, xrGLFactory, refSpace, scale, pos, orient);
                addEditorFilename(xrWindow, gl, xrGLFactory, refSpace, scale, pos, orient);
            }
        });
    }

    function addEditorStatus(editor, gl, xrGLFactory, refSpace, scale, pos, orient) {
        let status = editor.getStatus();
        let statusMessage = editor.getStatusMessage();
        let fullStatus = "Status: " + status + (statusMessage ? " (" + statusMessage + ")" : "");
        let textTexture = createLabel(gl, fullStatus, "grey", 12);
        let quadTexture1Width = editor.content.getImage().width;
        let quadTexture1Height = editor.content.getImage().height;
        let textLayer = xrGLFactory.createQuadLayer({
            space: refSpace,
            viewPixelWidth: quadTexture1Width,
            viewPixelHeight: quadTexture1Height,
            layout: "mono"
        });
        textLayer.width = quadTexture1Width * scale / 1000;
        textLayer.height = quadTexture1Height * scale / 1000;
        let yOffset = -textLayer.height - 0.4;
        // eslint-disable-next-line no-undef
        textLayer.transform = new XRRigidTransform({x: pos.x, y: pos.y + yOffset, z: pos.z}, orient);
        let textQuad = new QuadNode(textTexture, 2, true);
        textQuad.name = "status-" + editor.getId();
        textQuad.translation = [pos.x, pos.y + yOffset, pos.z];
        textQuad.rotation = [orient.x, orient.y, orient.z, orient.w];
        textQuad.scale = [textLayer.width, textLayer.height, 1];
        scene.addNode(textQuad);
        editor.setUserData("statusTexture", textTexture);
        editor.setUserData("statusLayer", textLayer);
        editor.setUserData("statusQuad", textQuad);
        editor.setUserData("statusNeedsRedraw", true);

        editor.addListener((_, type) => {
            if (type === "status") {
                console.log("Editor status changed: " + editor.getId() + " " + editor.getStatus());
                let status = editor.getStatus();
                let statusMessage = editor.getStatusMessage();
                let fullStatus = "Status: " + status + (statusMessage ? " (" + statusMessage + ")" : "");
                updateLabel(gl, textTexture, fullStatus, "grey", 12);
                editor.setUserData("statusNeedsRedraw", true);
            }
        });
    }

    function addEditorFilename(editor, gl, xrGLFactory, refSpace, scale, pos, orient) {
        let textTexture = createLabel(gl, editor.getFilename(), "white", 18);
        let quadTexture1Width = editor.content.getImage().width;
        let quadTexture1Height = editor.content.getImage().height;
        let textLayer = xrGLFactory.createQuadLayer({
            space: refSpace,
            viewPixelWidth: quadTexture1Width,
            viewPixelHeight: quadTexture1Height,
            layout: "mono"
        });
        textLayer.width = quadTexture1Width * scale / 1000;
        textLayer.height = quadTexture1Height * scale / 1000;
        let yOffset = 0.275;
        // eslint-disable-next-line no-undef
        textLayer.transform = new XRRigidTransform({x: pos.x, y: pos.y + yOffset, z: pos.z}, orient);
        let textQuad = new QuadNode(textTexture, 2, true);
        textQuad.name = "text-" + editor.getId();
        textQuad.translation = [pos.x, pos.y + yOffset, pos.z];
        textQuad.rotation = [orient.x, orient.y, orient.z, orient.w];
        textQuad.scale = [textLayer.width, textLayer.height, 1];
        scene.addNode(textQuad);
        editor.setUserData("textTexture", textTexture);
        editor.setUserData("textLayer", textLayer);
        editor.setUserData("textQuad", textQuad);
        editor.setUserData("textNeedsRedraw", true);

        editor.addListener((self, type) => {
            if (type === "selected") {
                if (editor.isSelected()) {
                    updateLabel(gl, textTexture, editor.getFilename(), "#3592C4", 18);
                    editor.setUserData("textNeedsRedraw", true);
                } else {
                    updateLabel(gl, textTexture, editor.getFilename(), "white", 18);
                    editor.setUserData("textNeedsRedraw", true);
                }
            }
        });
    }

    function createLabel(gl, text, color, fontSize) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        ctx.font = `${fontSize}px Arial`;
        ctx.fillStyle = color;
        ctx.fillText(text, 0, 30);

        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        return texture;
    }

    function updateLabel(gl, texture, text, color, fontSize) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        ctx.font = `${fontSize}px Arial`;
        ctx.fillStyle = color;
        ctx.fillText(text, 0, 30);

        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    //todo: should be based on quaternions or something, not hardcoded
    //todo: and XRWindows should be curved not flat
    function getPosOrient(editorId) {
        let pos, orient;
        switch (editorId) {
            case 0: // North
                pos = {x: 0, y: 0, z: -2.5};
                orient = {x: 0, y: 0, z: 0, w: 1};
                break;
            case 1: // North-East
                pos = {x: -1.75, y: 0, z: -1.5};
                orient = {x: 0, y: Math.PI / 5, z: 0, w: 1};
                break;
            case 2: // North-West
                pos = {x: 1.75, y: 0, z: -1.5};
                orient = {x: 0, y: -Math.PI / 5, z: 0, w: 1};
                break;
            case 3: // South-East
                pos = {x: -1.75, y: 0, z: 0.6};
                orient = {x: 0, y: -Math.PI / 2, z: 0, w: -1};
                break;
            case 4: // South-West
                pos = {x: 1.75, y: 0, z: 0.6};
                orient = {x: 0, y: Math.PI / 2, z: 0, w: -1};
                break;
            case 5: // South
                pos = {x: 0, y: 0, z: 1.6};
                orient = {x: 0, y: 1, z: 0, w: 0};
                break;
            default:
                throw new Error("Invalid index for quad layer creation");
        }
        return {pos, orient};
    }
}

function onEndSession() {
    xrSession.end();
}

function onSessionEnded(event) {
    if (event.session.isImmersive) {
        xrButton.setSession(null);
    }
    xrSession = null;
    gl = null;
}

//todo: move to xr client
let silentMode = false
let silentSetAt = -1

function onXRFrame(time, frame) {
    let pose = frame.getViewerPose(xrRefSpace);
    xrSession.requestAnimationFrame(onXRFrame);

    //todo: move to xr client
    let session = frame.session;
    for (let source of session.inputSources) {
        if (source.gamepad) {
            let buttons = source.gamepad.buttons
            let pressedButtons = buttons.filter(button => button.pressed);

            if (pressedButtons.length > 0) {
                silentSetAt = new Date().getTime()
                if (!silentMode) {
                    silentMode = true
                    console.log("Silence mode on")
                    const json = {
                        "type": "silent_mode",
                        "value": true
                    };
                    xrClient.sendMessage(json)
                }
            } else if (silentMode) {
                if (new Date().getTime() - silentSetAt < 200) {
                    console.log("ignore early change")
                    continue
                }
                silentMode = false
                console.log("Silence mode off")
                const json = {
                    "type": "silent_mode",
                    "value": false
                };
                xrClient.sendMessage(json)
            }
        }
    }

    //display editors and tool windows
    let toolWindows = xrClient.toolWindows;
    let toolWindowLayers = Array.from(toolWindows.values())
        .filter(toolWindow => toolWindow.isVisible())
        .map(toolWindow => toolWindow.getUserData("layer"))
        .filter(layer => layer);
    let editors = xrClient.editors;
    let editorLayers = Array.from(editors.values())
        .filter(editor => editor.isVisible())
        .map(editor => editor.getUserData("layer"))
        .filter(layer => layer);
    let textLayers = Array.from(editors.values())
        .filter(editor => editor.isVisible() && editor.isSelected())
        .map(editor => editor.getUserData("textLayer"))
        .filter(layer => layer);
    let statusLayers = Array.from(editors.values())
        .filter(editor => editor.isVisible() && editor.isSelected())
        .map(editor => editor.getUserData("statusLayer"))
        .filter(layer => layer);
    xrSession.updateRenderState({layers: [projLayer, ...toolWindowLayers, ...statusLayers, ...textLayers, ...editorLayers]});

    editors.forEach((editor, i) => {
        let statusTexture = editor.getUserData("statusTexture");
        let statusLayer = editor.getUserData("statusLayer");
        let statusNeedsRedraw = editor.getUserData("statusNeedsRedraw");
        if (editor.isVisible() && (statusLayer.needsRedraw || statusNeedsRedraw)) {
            editor.setUserData("statusNeedsRedraw", false);
            let fb3 = gl.createFramebuffer();
            let glLayer3 = xrGLFactory.getSubImage(statusLayer, frame);
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb3);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glLayer3.colorTexture, 0);
            let quadTexture1Width = editor.content.getImage().width;
            let quadTexture1Height = editor.content.getImage().height;
            let width = quadTexture1Width;
            let height = quadTexture1Height;
            stereoUtil.blit(false, statusTexture, 0, 0, 1, 1, width, height);
        }

        let textTexture = editor.getUserData("textTexture");
        let textLayer = editor.getUserData("textLayer");
        let textNeedsRedraw = editor.getUserData("textNeedsRedraw");
        if (editor.isVisible() && editor.isSelected() && (textLayer.needsRedraw || textNeedsRedraw)) {
            editor.setUserData("textNeedsRedraw", false);
            let fb2 = gl.createFramebuffer();
            let glLayer2 = xrGLFactory.getSubImage(textLayer, frame);
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb2);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glLayer2.colorTexture, 0);
            let quadTexture1Width = editor.content.getImage().width;
            let quadTexture1Height = editor.content.getImage().height;
            let width = quadTexture1Width;
            let height = quadTexture1Height;
            stereoUtil.blit(false, textTexture, 0, 0, 1, 1, width, height);
        }

        let texture = editor.getUserData("texture");
        let quadLayer = editor.getUserData("layer");
        let needsRedraw = editor.getUserData("needsRedraw")
        if (editor.isVisible() && (quadLayer.needsRedraw || needsRedraw)) {
            editor.setUserData("needsRedraw", false);
            let fb = gl.createFramebuffer();
            let glLayer = xrGLFactory.getSubImage(quadLayer, frame);
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glLayer.colorTexture, 0);
            let quadTexture1Width = editor.content.getImage().width;
            let quadTexture1Height = editor.content.getImage().height;
            let width = quadTexture1Width;
            let height = quadTexture1Height;
            stereoUtil.blit(false, texture, 0, 0, 1, 1, width, height);
        }
    });
    toolWindows.forEach((toolWindow, i) => {
        let texture = toolWindow.getUserData("texture");
        let layer = toolWindow.getUserData("layer");
        let needsRedraw = toolWindow.getUserData("needsRedraw");
        if (toolWindow.isVisible() && (layer?.needsRedraw || needsRedraw)) {
            toolWindow.setUserData("needsRedraw", false);
            let fb = gl.createFramebuffer();
            let glLayer = xrGLFactory.getSubImage(layer, frame);
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glLayer.colorTexture, 0);
            let quadTexture1Width = toolWindow.content.getImage().width;
            let quadTexture1Height = toolWindow.content.getImage().height;
            let width = quadTexture1Width;
            let height = quadTexture1Height;
            stereoUtil.blit(false, texture, 0, 0, 1, 1, width, height);
        }
    });

    if (pose) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, xrFramebuffer);
        scene.updateInputSources(frame, xrRefSpace);

        //determine active editor
        let pos = frame.getViewerPose(xrRefSpace).views[0];
        let hitResult = scene.hitTest(pos.transform);
        if (hitResult) {
            if (hitResult.node.name && hitResult.node.name.startsWith("editor-")) {
                let editorId = parseInt(hitResult.node.name.split("-")[1]);
                let editor = xrClient.editors.get(editorId);
                if (editor && editor.isVisible()) {
                    xrClient.setSelectedEditor(editorId);
                }
            }
        }

        let views = [];
        for (let view of pose.views) {
            let viewport = null;
            let glLayer = xrGLFactory.getViewSubImage(projLayer, view);
            glLayer.framebuffer = xrFramebuffer;
            viewport = glLayer.viewport;
            gl.bindFramebuffer(gl.FRAMEBUFFER, xrFramebuffer);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glLayer.colorTexture, 0);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, glLayer.depthStencilTexture, 0);
            views.push(new WebXRView(view, glLayer, viewport));
        }
        scene.drawViewArray(views);
    }
    scene.endFrame();
}

initXR();
