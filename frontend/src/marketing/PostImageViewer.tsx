import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { mediaSrc } from "../lib";
import type { MarketingModel } from "./useMarketingWorkspace";
export default function PostImageViewer({ model }: { model: MarketingModel }) {
  const { imageViewer, setImageViewer } = model;
  return (
    <>
      {imageViewer && imageViewer.images[imageViewer.index] && (
        <div
          className="overlay feed-image-viewer"
          role="dialog"
          aria-modal="true"
          aria-label="Full-size post image"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setImageViewer(null);
          }}
        >
          <div className="feed-image-viewer-panel">
            <button
              className="icon-button feed-image-viewer-close"
              aria-label="Close full-size image"
              onClick={() => setImageViewer(null)}
            >
              <X size={20} />
            </button>
            {imageViewer.images.length > 1 && (
              <button
                className="feed-image-viewer-nav feed-image-viewer-prev"
                aria-label="Previous image"
                onClick={() =>
                  setImageViewer((v) =>
                    v
                      ? {
                          ...v,
                          index:
                            (v.index - 1 + v.images.length) % v.images.length,
                        }
                      : v,
                  )
                }
              >
                <ArrowLeft size={22} />
              </button>
            )}
            <img
              src={mediaSrc(imageViewer.images[imageViewer.index])}
              alt={imageViewer.images[imageViewer.index].name}
            />
            {imageViewer.images.length > 1 && (
              <button
                className="feed-image-viewer-nav feed-image-viewer-next"
                aria-label="Next image"
                onClick={() =>
                  setImageViewer((v) =>
                    v ? { ...v, index: (v.index + 1) % v.images.length } : v,
                  )
                }
              >
                <ArrowRight size={22} />
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
