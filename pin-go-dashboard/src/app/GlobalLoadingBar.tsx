import { useIsFetching } from "@tanstack/react-query";
import { useEffect } from "react";
import NProgress from "nprogress";
import "nprogress/nprogress.css";

export function GlobalLoadingBar() {
  const isFetching = useIsFetching();

  useEffect(() => {
    if (isFetching > 0) {
      NProgress.start();
    } else {
      NProgress.done();
    }
  }, [isFetching]);

  return null;
}