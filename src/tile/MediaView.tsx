/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type TrackReferenceOrPlaceholder } from "@livekit/components-core";
import { animated } from "@react-spring/web";
import {
  type FC,
  type ComponentProps,
  type ReactNode,
  type ComponentType,
  type SVGAttributes,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import classNames from "classnames";
import { VideoTrack } from "@livekit/components-react";
import { Text, Tooltip } from "@vector-im/compound-web";
import {
  ErrorSolidIcon,
  PopOutIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";

import styles from "./MediaView.module.css";
import { Avatar } from "../Avatar";
import { RaisedHandIndicator } from "../reactions/RaisedHandIndicator";
import {
  showConnectionStats as showConnectionStatsSetting,
  showHandRaisedTimer,
  allowPipSetting,
  useSetting,
} from "../settings/settings";
import { type ReactionOption } from "../reactions";
import { ReactionIndicator } from "../reactions/ReactionIndicator";
import { RTCConnectionStats } from "../RTCConnectionStats";
import { enterPictureInPicture } from "../hostMedia";
import { platform } from "../Platform";

interface Props extends ComponentProps<typeof animated.div> {
  className?: string;
  style?: ComponentProps<typeof animated.div>["style"];
  targetWidth: number;
  targetHeight: number;
  video: TrackReferenceOrPlaceholder | undefined;
  videoFit: "cover" | "contain";
  mirror: boolean;
  userId: string;
  videoEnabled: boolean;
  unencryptedWarning: boolean;
  status?: { text: string; Icon: ComponentType<SVGAttributes<SVGElement>> };
  showNameTags: boolean;
  nameTagLeadingIcon?: ReactNode;
  displayName: string;
  mxcAvatarUrl: string | undefined;
  focusable: boolean;
  primaryButton?: ReactNode;
  raisedHandTime?: Date;
  currentReaction?: ReactionOption;
  raisedHandOnClick?: () => void;
  waitingForMedia?: boolean;
  audioStreamStats?: RTCInboundRtpStreamStats | RTCOutboundRtpStreamStats;
  videoStreamStats?: RTCInboundRtpStreamStats | RTCOutboundRtpStreamStats;
  rtcBackendIdentity?: string;
  // The focus url, mainly for debugging purposes
  focusUrl?: string;
  /** When false, the host (e.g. SpotlightTile) owns the PiP control. */
  showPipButton?: boolean;
}

export const MediaView: FC<Props> = ({
  ref,
  className,
  style,
  targetWidth,
  targetHeight,
  video,
  videoFit,
  mirror,
  userId,
  videoEnabled,
  unencryptedWarning,
  showNameTags,
  nameTagLeadingIcon,
  displayName,
  mxcAvatarUrl,
  focusable,
  primaryButton,
  status,
  raisedHandTime,
  currentReaction,
  raisedHandOnClick,
  waitingForMedia,
  audioStreamStats,
  videoStreamStats,
  rtcBackendIdentity,
  focusUrl,
  showPipButton: showPipButtonProp = true,
  ...props
}) => {
  const { t } = useTranslation();
  const [handRaiseTimerVisible] = useSetting(showHandRaisedTimer);
  const [showConnectionStats] = useSetting(showConnectionStatsSetting);
  const [allowPip] = useSetting(allowPipSetting);
  const mediaRef = useRef<HTMLDivElement | null>(null);
  const [inPictureInPicture, setInPictureInPicture] = useState(false);

  const avatarSize = Math.round(Math.min(targetWidth, targetHeight) / 2);
  const showPipButton =
    showPipButtonProp &&
    platform === "desktop" &&
    allowPip &&
    videoEnabled &&
    video?.publication !== undefined &&
    targetWidth >= 120;

  useEffect(() => {
    const onPipChange = (): void => {
      const videoEl = mediaRef.current?.querySelector("video") ?? null;
      setInPictureInPicture(document.pictureInPictureElement === videoEl);
    };
    document.addEventListener("enterpictureinpicture", onPipChange);
    document.addEventListener("leavepictureinpicture", onPipChange);
    return () => {
      document.removeEventListener("enterpictureinpicture", onPipChange);
      document.removeEventListener("leavepictureinpicture", onPipChange);
    };
  }, []);

  const onTogglePictureInPicture = useCallback(() => {
    const videoEl = mediaRef.current?.querySelector("video");
    if (!videoEl) return;
    void enterPictureInPicture(videoEl).catch(() => {
      // WKWebView may reject PiP until the video has rendered frames.
    });
  }, []);

  const warnings = unencryptedWarning && (
    <Tooltip
      label={t("common.unencrypted")}
      placement="bottom"
      isTriggerInteractive={false}
      nonInteractiveTriggerTabIndex={focusable ? undefined : -1}
    >
      <ErrorSolidIcon
        width={20}
        height={20}
        className={styles.errorIcon}
        role="img"
        aria-label={t("common.unencrypted")}
      />
    </Tooltip>
  );

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      mediaRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  return (
    <animated.div
      className={classNames(styles.media, className, {
        [styles.mirror]: mirror,
      })}
      style={style}
      ref={setRefs}
      data-testid="videoTile"
      data-video-fit={videoFit}
      {...props}
    >
      <div className={styles.bg}>
        <Avatar
          id={userId}
          name={displayName}
          size={avatarSize}
          src={mxcAvatarUrl}
          className={classNames(styles.avatar, {
            // When the avatar is overlaid with a status, make it translucent
            // for readability
            [styles.translucent]: status,
          })}
          style={{ display: video && videoEnabled ? "none" : "initial" }}
        />
        {video?.publication !== undefined && (
          <VideoTrack
            trackRef={video}
            // There's no reason for this to be focusable
            tabIndex={-1}
            disablePictureInPicture={!allowPip}
            style={{ display: video && videoEnabled ? "block" : "none" }}
            data-testid="video"
          />
        )}
      </div>
      <div className={styles.fg}>
        <div className={styles.reactions}>
          {showPipButton && (
            <button
              type="button"
              className={styles.pipButton}
              aria-label={
                inPictureInPicture
                  ? t("video_tile.exit_pip", "Exit picture in picture")
                  : t("video_tile.enter_pip", "Picture in picture")
              }
              aria-pressed={inPictureInPicture}
              data-enabled={inPictureInPicture || undefined}
              onClick={onTogglePictureInPicture}
              tabIndex={focusable ? undefined : -1}
              data-testid="video_pip"
            >
              <PopOutIcon aria-hidden width={18} height={18} />
            </button>
          )}
          <RaisedHandIndicator
            raisedHandTime={raisedHandTime}
            miniature={avatarSize < 96}
            showTimer={handRaiseTimerVisible}
            onClick={raisedHandOnClick}
            tabIndex={focusable ? undefined : -1}
          />
          {currentReaction && (
            <ReactionIndicator
              miniature={avatarSize < 96}
              emoji={currentReaction.emoji}
            />
          )}
        </div>
        {waitingForMedia && (
          <div className={styles.status}>
            {t("video_tile.waiting_for_media")}
            {showConnectionStats ? " " + rtcBackendIdentity : ""}
          </div>
        )}
        {showConnectionStats && (
          <>
            <RTCConnectionStats
              audio={audioStreamStats}
              video={videoStreamStats}
              focusUrl={focusUrl}
              rtcBackendIdentity={rtcBackendIdentity}
            />
          </>
        )}
        {status && (
          <div className={styles.status}>
            <status.Icon width={16} height={16} aria-hidden />
            <Text as="span" size="sm" weight="medium">
              {status.text}
            </Text>
          </div>
        )}
        {/* TODO: Bring this back once encryption status is less broken */}
        {/*encryptionStatus !== EncryptionStatus.Okay && (
            <div className={styles.status}>
              <Text as="span" size="sm" weight="medium" className={styles.name}>
                {encryptionStatus === EncryptionStatus.Connecting &&
                  t("e2ee_encryption_status.connecting")}
                {encryptionStatus === EncryptionStatus.KeyMissing &&
                  t("e2ee_encryption_status.key_missing")}
                {encryptionStatus === EncryptionStatus.KeyInvalid &&
                  t("e2ee_encryption_status.key_invalid")}
                {encryptionStatus === EncryptionStatus.PasswordInvalid &&
                  t("e2ee_encryption_status.password_invalid")}
              </Text>
            </div>
          )*/}
        {showNameTags && targetWidth >= 100 ? (
          <div className={styles.nameTag}>
            {nameTagLeadingIcon}
            <Text
              as="span"
              size="sm"
              weight="medium"
              className={styles.name}
              data-testid="name_tag"
            >
              {displayName}
            </Text>
            {warnings}
          </div>
        ) : (
          warnings
        )}
        {primaryButton}
      </div>
    </animated.div>
  );
};

MediaView.displayName = "MediaView";
