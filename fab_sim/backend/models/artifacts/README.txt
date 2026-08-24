학습된 모델(.pkl) 6개를 이 폴더에 넣으십시오.

  oxidation_model.pkl        1. 산화막 두께 (Ox_Thickness)
  softbake_model.pkl         2. 레지스트 균일도 (resist_uniformity)
  lithography_model.pkl      3. 회로 선폭 (CD)
  etch_total_drop_model.pkl  4. 전체 식각량 (Etch_Total_Drop)
  etch_selectivity_model.pkl 5. 선택비 (Selectivity)
  final_target_model.pkl     6. 결함 Die 수 (Target)

sklearn Pipeline 을 joblib.dump 로 저장한 형태 그대로 인식합니다.
입력 피처 목록은 pipeline.feature_names_in_ 에서 자동으로 읽습니다.
파일이 없으면 해당 모델만 스텁으로 대체되어 나머지는 정상 동작합니다.
