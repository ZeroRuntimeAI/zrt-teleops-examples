/** The front camera's frame rate: what the Follower announces for the `front` track. */
const FRONT_FPS = 30;

/**
 * The sim's front-camera canvas as a MediaStream, to publish as the room webcam.
 *
 * Carries the fields js-sdk's `createCameraVideoTrack` attaches. Without them js-sdk 1.2.1 sizes the
 * encodings from the track's constraints, which a canvas track does not have, and turns simulcast
 * on: the scale comes out NaN, `addTransceiver` throws, and the webcam produce fails (error 3049).
 * Nothing is then ever produced, so the send transport never connects and every `meeting.send` is
 * refused. "h480p_w640p" matches the 640x480 canvas; one layer is all a policy camera needs.
 */
export const frontStream = (canvas: HTMLCanvasElement): MediaStream =>
  Object.assign(canvas.captureStream(FRONT_FPS), { encoderConfig: "h480p_w640p", multiStream: false });
