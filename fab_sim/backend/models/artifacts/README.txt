학습된 모델(pkl)을 이 폴더에 넣으면 서버가 자동으로 인식합니다.

저장 형식:
    import joblib
    joblib.dump({
        "model": trained_model,
        "feature_keys": [...],
        "preprocessor": None,      # 선택
    }, "oxidation.pkl")

파일명:
    oxidation.pkl    1. 산화막 두께
    soft_bake.pkl    2. 레지스트 균일도
    lithography.pkl  3. Line CD
    etch.pkl         4. Thin F4
    implant.pkl      5. 주입 이온량
    yield.pkl        6. 최종 수율

넣은 뒤 POST /api/reload 호출하면 서버 재시작 없이 반영됩니다.
