import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { SceneVoice } from '../../../src/core/types';

interface Props {
  src: string;
  voice?: SceneVoice;
  className?: string;
  controls?: boolean;
  onEnded?: () => void;
  onPlay?: () => void;
  onPause?: () => void;
}

/**
 * <video> + the scene's TTS voice track kept in sync (play / pause / seek / rate). The clip's own
 * audio is ducked under the voice. If the voice is longer than the clip, `onEnded` fires when the
 * voice finishes (the merged movie holds the last frame the same way).
 */
export const SyncedVideo = forwardRef<HTMLVideoElement | null, Props>(function SyncedVideo(props, ref) {
  const v = useRef<HTMLVideoElement>(null);
  const a = useRef<HTMLAudioElement>(null);
  useImperativeHandle(ref, () => v.current!, []);
  const { voice } = props;

  useEffect(() => {
    const video = v.current;
    const audio = a.current;
    if (!video) return;
    video.volume = voice ? 0.35 : 1;
    if (!audio || !voice) return;
    const sync = () => {
      if (Math.abs(audio.currentTime - video.currentTime) > 0.25 && video.currentTime < (audio.duration || Infinity)) audio.currentTime = video.currentTime;
    };
    const play = () => {
      sync();
      if (video.currentTime < (audio.duration || Infinity)) audio.play().catch(() => {});
    };
    const pause = () => {
      if (!video.ended) audio.pause();
    };
    const rate = () => (audio.playbackRate = video.playbackRate);
    video.addEventListener('play', play);
    video.addEventListener('pause', pause);
    video.addEventListener('seeked', sync);
    video.addEventListener('ratechange', rate);
    return () => {
      video.removeEventListener('play', play);
      video.removeEventListener('pause', pause);
      video.removeEventListener('seeked', sync);
      video.removeEventListener('ratechange', rate);
      audio.pause();
    };
  }, [voice?.audio.url, props.src]);

  const onVideoEnded = () => {
    const audio = a.current;
    if (voice && audio && !audio.paused && !audio.ended) {
      audio.addEventListener('ended', () => props.onEnded?.(), { once: true });
      return;
    }
    props.onEnded?.();
  };

  return (
    <>
      <video
        ref={v}
        key={props.src}
        src={props.src}
        controls={props.controls}
        playsInline
        className={props.className}
        onEnded={onVideoEnded}
        onPlay={props.onPlay}
        onPause={props.onPause}
      />
      {voice && <audio ref={a} key={voice.audio.url} src={voice.audio.url} preload="auto" className="hidden" />}
    </>
  );
});
